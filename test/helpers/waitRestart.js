'use strict';

const fetch = require('node-fetch');

module.exports = (initTime = 200) => {
  const ping = async () => {
    return new Promise((resolve, reject) => {
      // ping _health
      fetch({
        url: 'http://localhost:1337/_health',
        method: 'HEAD',
        headers: {
          'Content-Type': 'application/json',
          'Keep-Alive': true,
        },
      }).then(resolve, reject);
    }).catch(() => {
      return new Promise((resolve) => {
        setTimeout(resolve, 200);
      }).then(ping);
    });
  };

  return new Promise((resolve) => {
    setTimeout(resolve, initTime);
  }).then(ping);
};
