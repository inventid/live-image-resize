import uuid from "uuid/v4";
import log from "./log";

import database from './databases';

const shouldRunCleanup = () => Math.floor(Math.random() * 10) === 0;

export default {
  createToken: async (id) => {
    try {
      const newToken = await database.createToken(id, uuid());
      if (newToken) {
        log('info', 'Created token successfully');
      }
      if (shouldRunCleanup()) {
        log('info', 'Running token database cleanup');
        await database.cleanupTokens();
      }
      return newToken;
    } catch (e) {
      log('error', e.stack);
      return null;
    }
  },
  consumeToken: async (token, id) => await database.consumeToken(token, id)
};
