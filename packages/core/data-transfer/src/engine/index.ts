import { PassThrough, Transform, Readable, Writable, Stream } from 'stream';
import { extname } from 'path';
import { isEmpty, uniq } from 'lodash/fp';
import { diff as semverDiff } from 'semver';
import type { Schema } from '@strapi/strapi';

import type {
  IAsset,
  IDestinationProvider,
  IEntity,
  IMetadata,
  ISourceProvider,
  ITransferEngine,
  ITransferEngineOptions,
  TransferProgress,
  ITransferResults,
  TransferStage,
  TransferTransform,
} from '../../types';
import type { Diff } from '../utils/json';

import { compareSchemas } from './validation/schemas';
import { filter, map } from '../utils/stream';

export const TRANSFER_STAGES: ReadonlyArray<TransferStage> = Object.freeze([
  'entities',
  'links',
  'assets',
  'schemas',
  'configuration',
]);

export const DEFAULT_VERSION_STRATEGY = 'ignore';
export const DEFAULT_SCHEMA_STRATEGY = 'strict';

type SchemaMap = Record<string, Schema>;

class TransferEngine<
  S extends ISourceProvider = ISourceProvider,
  D extends IDestinationProvider = IDestinationProvider
> implements ITransferEngine
{
  sourceProvider: ISourceProvider;

  destinationProvider: IDestinationProvider;

  options: ITransferEngineOptions;

  #metadata: { source?: IMetadata; destination?: IMetadata } = {};

  progress: {
    data: TransferProgress;
    stream: PassThrough;
  };

  constructor(
    sourceProvider: ISourceProvider,
    destinationProvider: IDestinationProvider,
    options: ITransferEngineOptions
  ) {
    if (sourceProvider.type !== 'source') {
      throw new Error("SourceProvider does not have type 'source'");
    }
    if (destinationProvider.type !== 'destination') {
      throw new Error("DestinationProvider does not have type 'destination'");
    }
    this.sourceProvider = sourceProvider;
    this.destinationProvider = destinationProvider;
    this.options = options;

    this.progress = { data: {}, stream: new PassThrough({ objectMode: true }) };
  }

  #createStageTransformStream<T extends TransferStage>(
    key: T,
    options: { includeGlobal?: boolean } = {}
  ): PassThrough | Transform {
    const { includeGlobal = true } = options;
    const { global: globalTransforms, [key]: stageTransforms } = this.options?.transforms ?? {};

    let stream = new PassThrough({ objectMode: true });

    const applyTransforms = <U>(transforms: TransferTransform<U>[] = []) => {
      for (const transform of transforms) {
        if ('filter' in transform) {
          stream = stream.pipe(filter(transform.filter));
        }

        if ('map' in transform) {
          stream = stream.pipe(map(transform.map));
        }
      }
    };

    if (includeGlobal) {
      applyTransforms(globalTransforms);
    }

    applyTransforms(stageTransforms as TransferTransform<unknown>[]);

    return stream;
  }

  #updateTransferProgress<T = unknown>(
    stage: TransferStage,
    data: T,
    aggregate?: {
      size?: (value: T) => number;
      key?: (value: T) => string;
    }
  ) {
    if (!this.progress.data[stage]) {
      this.progress.data[stage] = { count: 0, bytes: 0 };
    }

    const stageProgress = this.progress.data[stage];

    if (!stageProgress) {
      return;
    }

    const size = aggregate?.size?.(data) ?? JSON.stringify(data).length;
    const key = aggregate?.key?.(data);

    stageProgress.count += 1;
    stageProgress.bytes += size;

    // Handle aggregate updates if necessary
    if (key) {
      if (!stageProgress.aggregates) {
        stageProgress.aggregates = {};
      }

      const { aggregates } = stageProgress;

      if (!aggregates[key]) {
        aggregates[key] = { count: 0, bytes: 0 };
      }

      aggregates[key].count += 1;
      aggregates[key].bytes += size;
    }
  }

  #progressTracker(
    stage: TransferStage,
    aggregate?: {
      size?(value: unknown): number;
      key?(value: unknown): string;
    }
  ) {
    return new PassThrough({
      objectMode: true,
      transform: (data, _encoding, callback) => {
        this.#updateTransferProgress(stage, data, aggregate);
        this.#emitStageUpdate('progress', stage);
        callback(null, data);
      },
    });
  }

  #emitTransferUpdate(type: 'init' | 'start' | 'finish' | 'error', payload?: object) {
    this.progress.stream.emit(`transfer::${type}`, payload);
  }

  #emitStageUpdate(type: 'start' | 'finish' | 'progress' | 'skip', transferStage: TransferStage) {
    this.progress.stream.emit(`stage::${type}`, {
      data: this.progress.data,
      stage: transferStage,
    });
  }

  #assertStrapiVersionIntegrity(sourceVersion?: string, destinationVersion?: string) {
    const strategy = this.options.versionStrategy || DEFAULT_VERSION_STRATEGY;

    if (
      !sourceVersion ||
      !destinationVersion ||
      strategy === 'ignore' ||
      destinationVersion === sourceVersion
    ) {
      return;
    }

    let diff;
    try {
      diff = semverDiff(sourceVersion, destinationVersion);
    } catch (e: unknown) {
      throw new Error(
        `Strapi versions doesn't match (${strategy} check): ${sourceVersion} does not match with ${destinationVersion}`
      );
    }
    if (!diff) {
      return;
    }

    const validPatch = ['prelease', 'build'];
    const validMinor = [...validPatch, 'patch', 'prepatch'];
    const validMajor = [...validMinor, 'minor', 'preminor'];
    if (strategy === 'patch' && validPatch.includes(diff)) {
      return;
    }
    if (strategy === 'minor' && validMinor.includes(diff)) {
      return;
    }
    if (strategy === 'major' && validMajor.includes(diff)) {
      return;
    }

    throw new Error(
      `Strapi versions doesn't match (${strategy} check): ${sourceVersion} does not match with ${destinationVersion}`
    );
  }

  #assertSchemasMatching(sourceSchemas: SchemaMap, destinationSchemas: SchemaMap) {
    const strategy = this.options.schemaStrategy || DEFAULT_SCHEMA_STRATEGY;
    if (strategy === 'ignore') {
      return;
    }

    const keys = uniq(Object.keys(sourceSchemas).concat(Object.keys(destinationSchemas)));
    const diffs: { [key: string]: Diff[] } = {};

    keys.forEach((key) => {
      const sourceSchema = sourceSchemas[key];
      const destinationSchema = destinationSchemas[key];
      const schemaDiffs = compareSchemas(sourceSchema, destinationSchema, strategy);

      if (schemaDiffs.length) {
        diffs[key] = schemaDiffs;
      }
    });

    if (!isEmpty(diffs)) {
      throw new Error(
        `Import process failed because the project doesn't have a matching data structure 
        ${JSON.stringify(diffs, null, 2)}
        `
      );
    }
  }

  async #transferStage(options: {
    stage: TransferStage;
    source?: Readable;
    destination?: Writable;
    transform?: PassThrough;
    tracker?: PassThrough;
  }) {
    const { stage, source, destination, transform, tracker } = options;

    if (!source || !destination) {
      // Wait until source and destination are closed
      await Promise.allSettled(
        [source, destination].map((stream) => {
          // if stream is undefined or already closed, resolve immediately
          if (!stream || stream.destroyed) {
            return Promise.resolve();
          }

          // Wait until the close event is produced and then destroy the stream and resolve
          return new Promise((resolve, reject) => {
            stream.on('close', resolve).on('error', reject).destroy();
          });
        })
      );

      this.#emitStageUpdate('skip', stage);

      return;
    }

    this.#emitStageUpdate('start', stage);

    await new Promise<void>((resolve, reject) => {
      let stream: Stream = source;

      if (transform) {
        stream = stream.pipe(transform);
      }

      if (tracker) {
        stream = stream.pipe(tracker);
      }

      stream.pipe(destination).on('error', reject).on('close', resolve);
    });

    this.#emitStageUpdate('finish', stage);
  }

  async init(): Promise<void> {
    // Resolve providers' resource and store
    // them in the engine's internal state
    await this.#resolveProviderResource();

    // Update the destination provider's source metadata
    const { source: sourceMetadata } = this.#metadata;

    if (sourceMetadata) {
      this.destinationProvider.setMetadata?.('source', sourceMetadata);
    }
  }

  async bootstrap(): Promise<void> {
    await Promise.all([this.sourceProvider.bootstrap?.(), this.destinationProvider.bootstrap?.()]);
  }

  async close(): Promise<void> {
    await Promise.all([this.sourceProvider.close?.(), this.destinationProvider.close?.()]);
  }

  async #resolveProviderResource() {
    const sourceMetadata = await this.sourceProvider.getMetadata();
    const destinationMetadata = await this.destinationProvider.getMetadata();

    if (sourceMetadata) {
      this.#metadata.source = sourceMetadata;
    }

    if (destinationMetadata) {
      this.#metadata.destination = destinationMetadata;
    }
  }

  async integrityCheck(): Promise<boolean> {
    try {
      const sourceMetadata = await this.sourceProvider.getMetadata();
      const destinationMetadata = await this.destinationProvider.getMetadata();

      if (sourceMetadata && destinationMetadata) {
        this.#assertStrapiVersionIntegrity(
          sourceMetadata?.strapi?.version,
          destinationMetadata?.strapi?.version
        );
      }

      const sourceSchemas = (await this.sourceProvider.getSchemas?.()) as SchemaMap;
      const destinationSchemas = (await this.destinationProvider.getSchemas?.()) as SchemaMap;

      if (sourceSchemas && destinationSchemas) {
        this.#assertSchemasMatching(sourceSchemas, destinationSchemas);
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  async transfer(): Promise<ITransferResults<S, D>> {
    // reset data between transfers
    this.progress.data = {};

    try {
      this.#emitTransferUpdate('init');
      await this.bootstrap();
      await this.init();
      const isValidTransfer = await this.integrityCheck();
      if (!isValidTransfer) {
        // TODO: provide the log from the integrity check
        throw new Error(
          `Unable to transfer the data between ${this.sourceProvider.name} and ${this.destinationProvider.name}.\nPlease refer to the log above for more information.`
        );
      }

      this.#emitTransferUpdate('start');

      await this.beforeTransfer();
      // Run the transfer stages
      await this.transferSchemas();
      await this.transferEntities();
      await this.transferAssets();
      await this.transferLinks();
      await this.transferConfiguration();
      // Gracefully close the providers
      await this.close();

      this.#emitTransferUpdate('finish');
    } catch (e: unknown) {
      this.#emitTransferUpdate('error', { error: e });

      // Rollback the destination provider if an exception is thrown during the transfer
      // Note: This will be configurable in the future
      await this.destinationProvider.rollback?.(e as Error);
      throw e;
    }

    return {
      source: this.sourceProvider.results,
      destination: this.destinationProvider.results,
      engine: this.progress.data,
    };
  }

  async beforeTransfer(): Promise<void> {
    await this.sourceProvider.beforeTransfer?.();
    await this.destinationProvider.beforeTransfer?.();
  }

  async transferSchemas(): Promise<void> {
    const stage: TransferStage = 'schemas';

    const source = await this.sourceProvider.streamSchemas?.();
    const destination = await this.destinationProvider.getSchemasStream?.();

    const transform = this.#createStageTransformStream(stage);
    const tracker = this.#progressTracker(stage, { key: (value: Schema) => value.modelType });

    await this.#transferStage({ stage, source, destination, transform, tracker });
  }

  async transferEntities(): Promise<void> {
    const stage: TransferStage = 'entities';

    const source = await this.sourceProvider.streamEntities?.();
    const destination = await this.destinationProvider.getEntitiesStream?.();

    const transform = this.#createStageTransformStream(stage);
    const tracker = this.#progressTracker(stage, { key: (value: IEntity) => value.type });

    await this.#transferStage({ stage, source, destination, transform, tracker });
  }

  async transferLinks(): Promise<void> {
    const stage: TransferStage = 'links';

    const source = await this.sourceProvider.streamLinks?.();
    const destination = await this.destinationProvider.getLinksStream?.();

    const transform = this.#createStageTransformStream(stage);
    const tracker = this.#progressTracker(stage);

    await this.#transferStage({ stage, source, destination, transform, tracker });
  }

  async transferAssets(): Promise<void> {
    const stage: TransferStage = 'assets';

    const source = await this.sourceProvider.streamAssets?.();
    const destination = await this.destinationProvider.getAssetsStream?.();

    const transform = this.#createStageTransformStream(stage);
    const tracker = this.#progressTracker(stage, {
      size: (value: IAsset) => value.stats.size,
      key: (value: IAsset) => extname(value.filename),
    });

    await this.#transferStage({ stage, source, destination, transform, tracker });
  }

  async transferConfiguration(): Promise<void> {
    const stage: TransferStage = 'configuration';

    const source = await this.sourceProvider.streamConfiguration?.();
    const destination = await this.destinationProvider.getConfigurationStream?.();

    const transform = this.#createStageTransformStream(stage);
    const tracker = this.#progressTracker(stage);

    await this.#transferStage({ stage, source, destination, transform, tracker });
  }
}

export const createTransferEngine = <
  S extends ISourceProvider = ISourceProvider,
  D extends IDestinationProvider = IDestinationProvider
>(
  sourceProvider: S,
  destinationProvider: D,
  options: ITransferEngineOptions
): TransferEngine<S, D> => {
  return new TransferEngine<S, D>(sourceProvider, destinationProvider, options);
};