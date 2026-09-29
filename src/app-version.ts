import pkg from '../package.json';

/** The deployed app version — baked into the client bundle at build time from
 *  the same package.json value the .deb is named after. One source: the desk,
 *  the login footer (server-side read), and the deb filename cannot disagree.
 *  Note: the JSON default import is tree-shaken by vite to just the version value. */
export const APP_VERSION: string = pkg.version;
