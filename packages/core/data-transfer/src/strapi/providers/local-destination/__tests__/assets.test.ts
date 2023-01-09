import fse from 'fs-extra';
import { Writable, Readable } from 'stream';
import type { IAsset } from '../../../../../types';

import { getStrapiFactory } from '../../../../__tests__/test-utils';
import { createLocalStrapiDestinationProvider } from '../index';

const write = jest.fn((_chunk, _encoding, callback) => {
  callback();
});

const createWriteStreamMock = jest.fn(() => {
  return new Writable({
    objectMode: true,
    write,
  });
});

jest.mock('fs-extra');

describe('Local Strapi Destination Provider - Get Assets Stream', () => {
  test('Throws an error if the Strapi instance is not provided', async () => {
    /* @ts-ignore: disable-next-line */
    const provider = createLocalStrapiDestinationProvider({
      strategy: 'restore',
    });

    await expect(() => provider.getAssetsStream()).rejects.toThrowError(
      'Not able to stream Assets. Strapi instance not found'
    );
  });
  test('Returns a stream', async () => {
    const provider = createLocalStrapiDestinationProvider({
      getStrapi: getStrapiFactory({
        dirs: {
          static: {
            public: 'static/public/assets',
          },
        },
      }),
      strategy: 'restore',
    });
    await provider.bootstrap();

    const stream = await provider.getAssetsStream();

    expect(stream instanceof Writable).toBeTruthy();
  });

  test('Writes on the strapi assets path', async () => {
    (fse.createWriteStream as jest.Mock).mockImplementationOnce(createWriteStreamMock);
    const assetsDirectory = 'static/public/assets';
    const file: IAsset = {
      filename: 'test-photo.jpg',
      filepath: 'strapi-import-folder/assets',
      stats: { size: 200 },
      stream: Readable.from(['test', 'test-2']),
    };
    const provider = createLocalStrapiDestinationProvider({
      getStrapi: getStrapiFactory({
        dirs: {
          static: {
            public: assetsDirectory,
          },
        },
      }),
      strategy: 'restore',
    });

    await provider.bootstrap();
    const stream = await provider.getAssetsStream();

    const error = await new Promise<Error | null | undefined>((resolve) => {
      stream.write(file, resolve);
    });

    expect(error).not.toBeInstanceOf(Error);

    expect(write).toHaveBeenCalled();
    expect(createWriteStreamMock).toHaveBeenCalledWith(
      `${assetsDirectory}/uploads/${file.filename}`
    );
  });
});