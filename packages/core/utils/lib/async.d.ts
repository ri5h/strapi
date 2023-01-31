export type MapAsync<T = any, R = any> = lodash.CurriedFunction3<
  T[],
  (element: T, index: number) => R | Promise<R>,
  { concurrency?: number },
  Promise<R[]>
>;

export type ReduceAsync<T = any, V = T, R = V> = lodash.CurriedFunction3<
  T[],
  (accumulator: V | R, current: Awaited<T>, index: number) => R | Promise<R>,
  V,
  Promise<R>
>;
