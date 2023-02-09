'use strict';

const { curry } = require('lodash/fp');

const { pipeAsync } = require('../async');
const traverseEntity = require('../traverse-entity');
const traverseQueryFilters = require('../traverse-query-filters');

const { removePassword, removePrivate } = require('./visitors');

const sanitizePasswords = curry((schema, entity) => {
  return traverseEntity(removePassword, { schema }, entity);
});

const sanitizePrivates = curry((schema, entity) => {
  return traverseEntity(removePrivate, { schema }, entity);
});

const defaultSanitizeOutput = curry((schema, entity) => {
  return pipeAsync(sanitizePrivates(schema), sanitizePasswords(schema))(entity);
});

const sanitizeQueryFilters = curry((schema, entity) => {
  return traverseQueryFilters(removePrivate, { schema }, entity);
});

const defaultSanitizeParams = curry((schema, params) => {
  return pipeAsync(sanitizeQueryFilters(schema))(params);
});

module.exports = {
  sanitizePasswords,
  sanitizePrivates,
  defaultSanitizeOutput,
  defaultSanitizeParams,
};
