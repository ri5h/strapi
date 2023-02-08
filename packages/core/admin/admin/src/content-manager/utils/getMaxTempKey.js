let count = -1;

const getMaxTempKey = (arr) => {
  if (arr.length === 0) {
    return -1;
  }

  const maxTempKey = Math.max.apply(
    Math,
    arr.map((o) => {
      if (typeof o.__temp_key__ === 'undefined') {
        count++;

        return count;
      }

      return o.__temp_key__;
    })
  );

  return Number.isNaN(maxTempKey) ? -1 : maxTempKey;
};

export default getMaxTempKey;
