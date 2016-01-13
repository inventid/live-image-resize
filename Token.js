import uuid from 'node-uuid';

import log from './Log';

const insertToken = `INSERT INTO tokens (id, image_id, valid_until, used) VALUES ($1,$2,now() + interval '15 minute', 0)`;
const consumeToken = `UPDATE tokens SET used=1 WHERE id=$1 AND image_id=$2 AND valid_until >= now() AND used=0`;
const deleteOldTokens = `DELETE FROM tokens WHERE valid_until < datetime('now') AND used=0`;
let db;

const Token = {
  setDb(database) {
    db = database;
  },
  // This method is madness, but node-sqlite3 binds the this, so #noLambda
  consume(token, id, callback) {
    db.query(consumeToken, [token, id], function (err) {
      callback(err, this);
    });
  },
  create(req, res) {
    // Here we create a token which is valid for one single upload
    // This way we can directly send the file here and just a small json payload to the app
    const newToken = uuid.v4();
    if (!req.body.id) {
      res.writeHead(400, 'Bad request');
      return res.end();
    }
    // Ensure the id wasnt requested or used previously
    db.query(insertToken, [newToken, req.body.id], (err) => {
      if (!err) {
        res.json({token: newToken}).end();
        log.log('info', 'Created token successfully');
        if (Token.shouldRunCleanup()) {
          Token.cleanup();
        }
      } else {
        res.statusCode = 403;
        res.json({error: 'The requested image_id is already requested'}).end();
      }
    });
  },
  shouldRunCleanup() {
    return Math.floor(Math.random() * 10) === 0;
  },
  cleanup() {
    log.log('info', 'Doing a token cleanup');
    db.query(deleteOldTokens, [], (err) => {
      if (!err) {
        log.log('info', `Cleaned ${this.changes} tokens from the db`);
      } else {
        log.log('error', `Encountered error ${err} when cleaning up tokens`);
      }
    });
  }
};

export default Token;