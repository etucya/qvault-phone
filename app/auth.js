// Google sign-in through Google Identity Services' token client (the GIS script is loaded by
// index.html). Tokens live in memory only and last about an hour; getToken() renews them
// silently while it can. Every touch of the `google` global is guarded so this module also
// imports in Node.

const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const ABOUT = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';
const EMAIL_KEY = 'qvault.account';
const SILENT_TIMEOUT_MS = 5000;
const REVOKE_TIMEOUT_MS = 5000;
const EXPIRY_MARGIN_MS = 60_000;

const oauth2 = () => globalThis.google?.accounts?.oauth2 ?? null;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key) {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    // Private browsing or storage blocked: the value just is not remembered.
  }
}

export function createAuth({ clientId, scope = DRIVE_READONLY } = {}) {
  let client = null;
  let token = null;
  let expiresAt = 0;
  let email = read(EMAIL_KEY);
  let consented = false; // in memory only: a token was granted in this page's lifetime
  let pending = null; // { resolve, reject } for the request in flight
  let refreshing = null; // the one silent refresh in flight, shared by concurrent getToken callers
  let signingIn = null; // the one interactive sign-in in flight, shared by concurrent signIn callers

  function settle(outcome, value) {
    const waiting = pending;
    pending = null;
    waiting?.[outcome](value);
  }

  function ensureClient() {
    if (client) return client;
    const gis = oauth2();
    if (!gis?.initTokenClient) throw new Error('Google sign-in is not loaded');
    const options = {
      client_id: clientId,
      scope,
      callback: (response) => {
        if (!response || response.error || !response.access_token) {
          settle('reject', new Error(response?.error_description || response?.error || 'Sign-in failed'));
          return;
        }
        token = response.access_token;
        expiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000 - EXPIRY_MARGIN_MS;
        consented = true;
        settle('resolve', token);
      },
      error_callback: (error) => {
        settle('reject', new Error(error?.message || error?.type || 'Sign-in failed'));
      },
    };
    if (email) options.login_hint = email;
    client = gis.initTokenClient(options);
    return client;
  }

  function request(prompt) {
    const tokenClient = ensureClient();
    // A newer request supersedes one that never came back (a closed popup, say).
    settle('reject', new Error('Sign-in superseded'));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      try {
        tokenClient.requestAccessToken({ prompt });
      } catch (error) {
        settle('reject', error);
      }
    });
  }

  async function lookUpEmail(accessToken) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    try {
      const response = await globalThis.fetch(USERINFO, { headers });
      if (response.ok) {
        const info = await response.json();
        if (info.email) return info.email;
      }
    } catch {
      // fall through to Drive's own account record
    }
    try {
      // With only the Drive scope, userinfo may carry no email; Drive's about record does.
      const response = await globalThis.fetch(ABOUT, { headers });
      if (response.ok) return (await response.json()).user?.emailAddress ?? null;
    } catch {
      // the account line simply stays blank
    }
    return null;
  }

  const fresh = () => token !== null && Date.now() < expiresAt;

  async function interactiveSignIn() {
    const accessToken = await request('consent');
    if (!email) {
      const found = await lookUpEmail(accessToken);
      if (found) {
        email = found;
        write(EMAIL_KEY, found);
      }
    }
    return accessToken;
  }

  function silentRefresh() {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        // Drop the request that never answered so the next attempt starts clean.
        settle('reject', new Error('Silent sign-in timed out'));
        resolve(null);
      }, SILENT_TIMEOUT_MS);
    });
    return Promise.race([request(''), timeout])
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  return {
    /** Interactive sign-in (always shows consent). Resolves to an access token. */
    signIn() {
      if (fresh()) return Promise.resolve(token);
      if (!signingIn) {
        const flight = interactiveSignIn().finally(() => {
          if (signingIn === flight) signingIn = null;
        });
        signingIn = flight;
      }
      return signingIn;
    },

    /** A live token, renewing silently when it can; null when the user has to tap sign-in. */
    async getToken() {
      if (fresh()) return token;
      if (signingIn) return signingIn.catch(() => null);
      if (!oauth2() || !consented) return null;
      if (!refreshing) {
        const flight = silentRefresh().finally(() => {
          if (refreshing === flight) refreshing = null;
        });
        refreshing = flight;
      }
      return refreshing;
    },

    async signOut() {
      const old = token;
      token = null;
      expiresAt = 0;
      email = null;
      client = null;
      consented = false;
      refreshing = null;
      signingIn = null;
      settle('reject', new Error('Signed out'));
      write(EMAIL_KEY, null);
      const gis = oauth2();
      if (old && gis?.revoke) {
        let timer;
        await Promise.race([
          new Promise((resolve) => {
            try {
              gis.revoke(old, () => resolve());
            } catch {
              resolve();
            }
          }),
          // Offline, the revoke callback may never come; do not hang the sign-out on it.
          new Promise((resolve) => {
            timer = setTimeout(resolve, REVOKE_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
      }
    },

    /** The signed-in account's email, when known. */
    account() {
      return email;
    },
  };
}
