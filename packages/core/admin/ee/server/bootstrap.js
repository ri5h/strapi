'use strict';

const _ = require('lodash');
// eslint-disable-next-line node/no-extraneous-require
const { features } = require('@strapi/strapi/lib/utils/ee');
const executeCEBootstrap = require('../../server/bootstrap');
const { getService } = require('../../server/utils');

const SSO_ACTIONS = [
  {
    uid: 'provider-login.read',
    displayName: 'Read',
    pluginName: 'admin',
    section: 'settings',
    category: 'single sign on',
    subCategory: 'options',
  },
  {
    uid: 'provider-login.update',
    displayName: 'Update',
    pluginName: 'admin',
    section: 'settings',
    category: 'single sign on',
    subCategory: 'options',
  },
];

const enableUsersToLicenseLimit = async (numberOfUsersToEnable) => {
  const data = await strapi.db.query('strapi:ee-store').findOne({
    where: { key: 'ee_disabled_users' },
  });

  if (!data || !data.value || data.value.length === 0) return;

  const disabledUsers = JSON.parse(data.value);

  const usersToEnable = _.take(disabledUsers, numberOfUsersToEnable);

  usersToEnable.forEach(async (user) => {
    const data = await strapi.db.query('admin::user').findOne({
      where: { id: user.id },
    });

    if (!data) return;

    await strapi.db.query('admin::user').update({
      where: { id: user.id },
      data: { isActive: true },
    });
  });

  // TODO: sync new list of disabled users with ee_store in case some are left
};

const calculateAdminSeatDifference = async (seatsAllowedByLicense) => {
  const currentAdminSeats = await strapi.db.query('admin::user').count({
    where: {
      isActive: true,
    },
  });
  return currentAdminSeats - seatsAllowedByLicense;
};

const disableUsersAboveLicenseLimit = async (numberOfUsersToDisable) => {
  const users = await strapi.db.query('admin::user').findMany({
    where: { isActive: 'true' },
    orderBy: { createdAt: 'DESC' },
    populate: { roles: { select: ['id'] } },
  });

  const usersToDisable = _.take(users, numberOfUsersToDisable);

  console.log(usersToDisable);

  usersToDisable.forEach(async (user) => {
    user.isActive = false;
    await strapi.db.query('admin::user').update({
      where: { id: user.id },
      data: {
        isActive: false,
      },
    });
  });

  const data = await strapi.db.query('strapi:ee-store').findOne({
    where: { key: 'ee_disabled_users' },
  });

  console.log('data run done', data);

  if (data) {
    return strapi.db.query('strapi:ee-store').update({
      where: { id: data.id },
      data: { value: JSON.stringify(usersToDisable) },
    });
  }

  return strapi.db.query('strapi:ee-store').create({
    data: {
      key: 'ee_disabled_users',
      value: JSON.stringify(usersToDisable),
    },
  });
};

const syncdDisabledUserRecords = async () => {
  const data = await strapi.db.query('strapi:ee-store').findOne({
    where: { key: 'ee_disabled_users' },
  });

  if (!data || !data.value || data.value.length === 0) return;

  console.log(data);

  const disabledUsers = JSON.parse(data.value);
  disabledUsers.forEach(async (user) => {
    const data = await strapi.db.query('admin::user').findOne({
      where: { id: user.id },
    });

    if (!data) return;

    await strapi.db.query('admin::user').update({
      where: { id: user.id },
      data: { isActive: user.isActive },
    });
  });
};

module.exports = async () => {
  const { actionProvider } = getService('permission');

  if (features.isEnabled('sso')) {
    await actionProvider.registerMany(SSO_ACTIONS);
  }

  // TODO: check admin seats
  await syncdDisabledUserRecords();

  const permittedAdminSeats = 15;

  const adminSeatDifference = await calculateAdminSeatDifference(permittedAdminSeats);

  switch (true) {
    case adminSeatDifference === 0:
      console.log('Breaking out early');
      break;
    case adminSeatDifference > 0:
      console.log('Disabling users');
      await disableUsersAboveLicenseLimit(adminSeatDifference);
      break;
    case adminSeatDifference < 0:
      console.log('Enabling users');
      await enableUsersToLicenseLimit(Math.abs(adminSeatDifference));
      break;
    default:
      break;
  }

  await executeCEBootstrap();
};
