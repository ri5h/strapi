'use strict';

const pMap = require('p-map');
const { curry } = require('lodash/fp');

function pipeAsync(...methods) {
  return async (data) => {
    let res = data;

    for (const method of methods) {
      res = await method(res);
    }

    return res;
  };
}

/**
 * @type { import('./async').MapAsync }
 */
const mapAsync = curry(pMap);

/**
 * @type { import('./async').ReduceAsync }
 */
const reduceAsync = curry(async (mixedArray, iteratee, initialValue) => {
  let acc = initialValue;
  for (let i = 0; i < mixedArray.length; i += 1) {
    acc = await iteratee(acc, mixedArray[i], i);
  }
  return acc;
});

module.exports = {
  mapAsync,
  reduceAsync,
  pipeAsync,
};
