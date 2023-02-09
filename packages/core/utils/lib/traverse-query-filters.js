'use strict';

const { cloneDeep, isObject, isArray, isEmpty, isNil, curry, set } = require('lodash/fp');

const traverseQueryFilters = async (visitor, options, filters) => {
  const { path = { raw: null, entity: null }, schema } = options;

  if (isArray(filters)) {
    const results = await Promise.all(
      filters.map((nestedFilters, i) => {
        const nestedOptions = set('path.raw', `${path.raw}[${i}]`, options);
        return traverseQueryFilters(visitor, nestedOptions, nestedFilters);
      })
    );

    return results.filter((val) => {
      return !(isObject(val) && isEmpty(val));
    });
  }

  // End recursion
  if (!isObject(filters) || isNil(schema)) {
    return filters;
  }

  // Don't mutate the original entity object
  const copy = cloneDeep(filters);

  for (const key of Object.keys(copy)) {
    // Retrieve the attribute definition associated to the key from the schema
    const attribute = schema.attributes[key];
    const isAttribute = !isNil(attribute);

    const newPath = updatePath(path, key, { isAttribute });

    // Visit the current attribute
    const visitorOptions = {
      data: copy,
      schema,
      key,
      value: copy[key],
      attribute,
      path: newPath,
    };
    const visitorUtils = createVisitorUtils({ data: copy });

    await visitor(visitorOptions, visitorUtils);

    // Extract the value for the current key (after calling the visitor)
    const value = copy[key];

    // Ignore Nil values
    if (isNil(value)) {
      continue;
    }

    // Remove empty objects
    if (isObject(value) && isEmpty(value)) {
      delete copy[key];
      continue;
    }

    if (!isAttribute) {
      copy[key] = await traverseQueryFilters(visitor, { schema, path: newPath }, value);
      continue;
    }

    const isRelation = attribute.type === 'relation';
    const isComponent = attribute.type === 'component';
    const isDynamicZone = attribute.type === 'dynamiczone';
    const isMedia = attribute.type === 'media';

    if (isRelation) {
      const isMorphRelation = attribute.relation.toLowerCase().startsWith('morph');

      if (isMorphRelation) {
        delete copy[key];
        return copy;
      }

      const traverseTarget = (nestedFilters) => {
        // Handle polymorphic relationships
        const targetSchemaUID = attribute.target;
        const targetSchema = strapi.getModel(targetSchemaUID);

        const traverseOptions = { schema: targetSchema, path: newPath };

        return traverseQueryFilters(visitor, traverseOptions, nestedFilters);
      };

      // need to update copy
      copy[key] = isArray(value)
        ? await Promise.all(value.map(traverseTarget))
        : await traverseTarget(value);
    }

    if (isMedia) {
      const traverseTarget = (entry) => {
        const targetSchemaUID = 'plugin::upload.file';
        const targetSchema = strapi.getModel(targetSchemaUID);

        const traverseOptions = { schema: targetSchema, path: newPath };

        return traverseQueryFilters(visitor, traverseOptions, entry);
      };

      // need to update copy
      copy[key] = isArray(value)
        ? await Promise.all(value.map(traverseTarget))
        : await traverseTarget(value);
    }

    if (isComponent) {
      const targetSchema = strapi.getModel(attribute.component);
      const traverseOptions = { schema: targetSchema, path: newPath };

      const traverseComponent = (entry) => traverseQueryFilters(visitor, traverseOptions, entry);

      copy[key] = isArray(value)
        ? await Promise.all(value.map(traverseComponent))
        : await traverseComponent(value);
    }

    if (isDynamicZone && isArray(value)) {
      delete copy[key];
      return copy;
    }
  }
  return copy;
};

const createVisitorUtils = ({ data }) => ({
  remove(key) {
    delete data[key];
  },

  set(key, value) {
    data[key] = value;
  },
});

const updatePath = (path, key, { isAttribute } = {}) => {
  const rawPath = path.raw ? `${path.raw}.${key}` : key;

  let entityPath;

  if (isAttribute) {
    entityPath = path.entity ? `${path.entity}.${key}` : key;
  } else {
    entityPath = path.entity;
  }

  return {
    raw: rawPath,
    entity: entityPath,
  };
};

module.exports = curry(traverseQueryFilters);
