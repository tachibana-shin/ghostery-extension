/**
 * Ghostery Browser Extension
 * https://www.ghostery.com/
 *
 * Copyright 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0
 */

import { jwtDecode } from 'jwt-decode';

import { GHOSTERY_DOMAIN } from '/utils/urls.js';
import { stagingMode } from './debug.js';

const AUTH_URL = `https://consumerapi.${GHOSTERY_DOMAIN}/api/v2`;
const ACCOUNT_URL = `https://accountapi.${GHOSTERY_DOMAIN}/api/v2.1.0`;

export const CDN_URL = stagingMode
  ? 'https://staging-cdn.ghostery.com/'
  : 'https://cdn.ghostery.com/';

export const COOKIE_DOMAIN = `.${GHOSTERY_DOMAIN}`;
const COOKIE_URL = `https://${GHOSTERY_DOMAIN}`;
const COOKIE_DURATION = 60 * 60 * 24 * 90; // 90 days in seconds
const COOKIE_SHORT_DURATION = 60 * 60; // 1 hour in seconds
let COOKIE_EXPIRATION_DATE_OFFSET = 0;

if (__PLATFORM__ === 'safari') {
  // Safari has two major inconsistency with the specification:
  // * for cookies.set() the `expirationDate` is in seconds since 2001-01-01T00:00:00Z (instead of beginning of epoch)
  // * cookies.get() returns the cookie with `expirationDate` in in milliseconds (instead of seconds)
  //
  // Below code tries to detect the offset between the two
  // and use it to convert the expirationDate to seconds

  // TODO: Tested on Safari 18.3.1 - both issue are fixed.
  // Remove this code when we drop support for older versions
  (async () => {
    try {
      const cookie = await chrome.cookies.set({
        url: COOKIE_URL,
        domain: COOKIE_DOMAIN,
        path: '/',
        name: 'test',
        value: '',
        expirationDate: 1,
      });

      // Other browsers don't return a cookie with expirationDate is in the past
      if (cookie) {
        const date = new Date(cookie.expirationDate);

        // If the year is not 1970, it means there is a bug
        if (date.getFullYear() !== 1970) {
          COOKIE_EXPIRATION_DATE_OFFSET = -Math.round(
            // Clear "1" from setting the cookie and transform to seconds
            (cookie.expirationDate - 1000) / 1000,
          );
        }
      }
    } catch {
      // Protect against throwing an error when trying to detect the offset
    }
  })();
}

async function isFirstPartyIsolation() {
  // Safari has a bug with cookies.getAll(),
  // which shows a permission popup to the user about random domains.
  // This feature is not yet supported in Safari we can safely return false.
  if (__PLATFORM__ !== 'safari') {
    if (isFirstPartyIsolation.value === undefined) {
      try {
        await chrome.cookies.getAll({ domain: '' });
        isFirstPartyIsolation.value = false;
      } catch (e) {
        isFirstPartyIsolation.value =
          e.message.indexOf('firstPartyDomain') > -1;
      }
    }

    return isFirstPartyIsolation.value;
  } else {
    return false;
  }
}

async function getCookie(name) {
  const cookie = await chrome.cookies.get({
    url: COOKIE_URL,
    name,
    ...((await isFirstPartyIsolation())
      ? { firstPartyDomain: GHOSTERY_DOMAIN }
      : {}),
  });

  if (cookie) {
    if (cookie.session) return cookie;

    let expirationDate = cookie.expirationDate;

    // By the specs, the `expirationDate` should be in seconds since the epoch
    // and we need to convert it to milliseconds, but Safari returns it in milliseconds

    // TODO: Tested on Safari 18.3.1 - issue fixed
    // Multiple date for all platforms when we drop support
    // for older versions of Safari
    if (
      __PLATFORM__ !== 'safari' ||
      new Date(expirationDate).getFullYear() === 1970
    ) {
      expirationDate = expirationDate * 1000;
    }

    if (expirationDate > Date.now()) {
      return cookie;
    }
  }

  return null;
}

export async function setCookie(name, value, durationInSec = COOKIE_DURATION) {
  return chrome.cookies[value !== undefined ? 'set' : 'remove']({
    name,
    url: COOKIE_URL,
    ...(value !== undefined
      ? {
          path: '/',
          value,
          domain: COOKIE_DOMAIN,
          expirationDate:
            Date.now() / 1000 + durationInSec + COOKIE_EXPIRATION_DATE_OFFSET,
        }
      : {}),
    ...((await isFirstPartyIsolation())
      ? { firstPartyDomain: GHOSTERY_DOMAIN }
      : {}),
  });
}

/*
  WARNING: This function is meant bo be used only by the Session store model.
  It is not intended to be used by any other part of the extension.
  If you need to get user's session, use the `store.resolve(Session)` or similar...
*/
export async function session() {
  const userId = await getCookie('user_id');
  if (!userId) return null;

  let accessToken = await getCookie('access_token');

  try {
    if (!accessToken) {
      const refreshToken = await getCookie('refresh_token');
      if (!refreshToken) return null;

      const res = await fetch(`${AUTH_URL}/refresh_token`, {
        method: 'post',
        headers: {
          UserId: userId.value,
          RefreshToken: refreshToken.value,
        },
        credentials: 'omit',
      });

      if (res.ok) {
        const data = await res.json();
        accessToken = { value: data.access_token };

        await Promise.all([
          setCookie('user_id', data.user_id),
          setCookie('refresh_token', data.refresh_token),
          setCookie('access_token', data.access_token, COOKIE_SHORT_DURATION),
          setCookie('csrf_token', data.csrf_token, COOKIE_SHORT_DURATION),
        ]);
      } else if (res.status === 400) {
        // If the response code is 400, it means the server processed
        // the request correctly, but the refresh token must be corrupted
        // and we should remove user session from the browser
        await Promise.all([
          setCookie('user_id', undefined),
          setCookie('refresh_token', undefined),
          setCookie('access_token', undefined),
          setCookie('csrf_token', undefined),
        ]);

        throw new Error('Invalid refresh token');
      } else {
        throw new Error(`${res.status}: ${res.statusText}`);
      }
    }
  } catch (e) {
    console.error('[api] Failed to refresh access token:', e);
    accessToken = undefined;
  }

  return accessToken ? jwtDecode(accessToken.value) : null;
}

export async function getUserOptions() {
  const userId = await getCookie('user_id');
  const accessToken = await getCookie('access_token');
  const csrfToken = await getCookie('csrf_token');

  const res = await fetch(`${ACCOUNT_URL}/options/${userId.value}`, {
    headers: {
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${accessToken.value}`,
      'X-CSRF-Token': csrfToken.value,
    },
    credentials: 'omit',
  });

  if (!res.ok) {
    throw Error(`Failed to get options: ${res.status} ${res.statusText}`);
  }

  return (await res.json()).data.attributes.options || {};
}

export async function setUserOptions(options) {
  const userId = await getCookie('user_id');
  const accessToken = await getCookie('access_token');
  const csrfToken = await getCookie('csrf_token');

  const res = await fetch(`${ACCOUNT_URL}/options/${userId.value}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${accessToken.value}`,
      'X-CSRF-Token': csrfToken.value,
    },
    credentials: 'omit',
    body: JSON.stringify({
      data: {
        type: 'options',
        id: userId.value,
        attributes: { options },
      },
    }),
  });

  if (!res.ok) {
    throw Error(`Failed to save options: ${res.status} ${res.statusText}`);
  }

  return (await res.json()).data.attributes.options || {};
}
