import timingMetric from "../metrics/timingMetric";
import {native} from 'pg';
import migrateAndStart from "pg-migration";
import config from "config";
import log from '../log';
import metrics, {DATABASE} from '../metrics';

require("babel-polyfill");

// Queries
const insertToken = `INSERT INTO tokens (id, image_id, valid_until, used) VALUES ($1,$2,now() + interval '15 minute', 0)`;
const consumeTokens = `UPDATE tokens SET used=1 WHERE id=$1 AND image_id=$2 AND valid_until >= now() AND used=0`;
const deleteToken = `DELETE FROM tokens WHERE used=1 AND uploaded_at is null AND image_id=$1`;
const markAsCompleted = `UPDATE tokens SET uploaded_at = NOW() WHERE id=$1 AND image_id=$2 AND valid_until >= now() AND used=1`;
const deleteOldTokens = `DELETE FROM tokens WHERE valid_until < NOW() AND used=0`;
const selectImageIds = `SELECT image_id, uploaded_at FROM tokens WHERE uploaded_at IS NOT NULL AND uploaded_at > $1 AND used=1`;
const emptyUploadedAt = `SELECT id, image_id FROM tokens WHERE uploaded_at IS NULL AND used=1 LIMIT 2500`;
const setUploadedAtIfEmpty = `UPDATE tokens SET uploaded_at = $2 WHERE image_id = $1 AND uploaded_at IS NULL`;
const insertImage = 'INSERT INTO images (id, x, y, fit, file_type, url, blur, quality, rendered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)';
const selectImage = 'SELECT url FROM images WHERE id=$1 AND x=$2 AND y=$3 AND fit=$4 AND file_type=$5 AND blur=$6 AND quality=$7'; //eslint-disable-line max-len
const selectNextAppMigration = 'SELECT name from appchangelog where completed_at is null order by created_at asc limit 1;'; //eslint-disable-line max-len
const markMigrationAsCompleted = 'UPDATE appchangelog SET completed_at = NOW() where completed_at is null and name=$1'; //eslint-disable-line max-len

const poolSize = (config.has('postgresql.pool') && Number(config.get('postgresql.pool'))) || 5;

export default function postgresql() {
  const configs = {
    user: config.get('postgresql.user'),
    database: config.get('postgresql.database'),
    password: config.get('postgresql.password'),
    host: config.get('postgresql.host'),
    port: 5432,
    max: poolSize,
    idleTimeoutMillis: 30000
  };

  const pool = new native.Pool(configs);

  pool.on('error', function (err) {
    log('error', `idle client error ${err.message} ${err.stack}`);
  });

  async function isDbAlive() {
    const testQuery = 'SELECT 1';
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'isDbAlive'}});
    try {
      const result = await pool.query(testQuery, []);
      return Boolean(result.rowCount && result.rowCount === 1);
    } catch (e) {
      return false;
    } finally {
      metrics.write(metric);
    }
  }

  async function cleanupTokens() {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'cleanupTokens'}});
    try {
      const result = await pool.query(deleteOldTokens, []);
      log('info', `Cleaned ${result.rowCount} tokens from the db`);
    } catch (e) {
      log('error', `Encountered error ${e} when cleaning up tokens`);
    } finally {
      metrics.write(metric);
    }
  }

  async function createToken(id, newToken) {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'createToken'}});
    try {
      const result = await pool.query(insertToken, [newToken, id]);
      if (result.rowCount === 1) {
        return newToken;
      }
    } catch (e) {
      const message = e.toString();
      if (message.includes('duplicate key value violates unique constraint')) {
        // A client re-requested a previously requested image_id token
        log('warn', `Two image uploading requests for token raced to be saved in the database. Denying this one '${id}'.`);
      } else {
        log('error', message);
      }
    } finally {
      metrics.write(metric);
    }
    return undefined;
  }

  async function consumeToken(token, id) {
    const vars = [token, id];
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'consumeToken'}});
    try {
      const result = await pool.query(consumeTokens, vars);
      return result.rowCount === 1;
    } catch (e) {
      log('error', e.stack);
      return false;
    } finally {
      metrics.write(metric);
    }
  }

  async function deleteTokenForImageId(id) {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'deleteTokenForImageId'}});
    metrics.write(metric);
    await pool.query(deleteToken, [id]);
  }

  async function markUploadAsCompleted(token, id) {
    const vars = [token, id];
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'markUploadAsCompleted'}});
    try {
      const result = await pool.query(markAsCompleted, vars);
      return result.rowCount === 1;
    } catch (e) {
      log('error', e.stack);
      return false;
    } finally {
      metrics.write(metric);
    }
  }

  async function getFromCache(params) {
    const vars = [params.name,
      params.width,
      params.height,
      params.fit,
      params.mime,
      Boolean(params.blur),
      params.quality
    ];

    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'getFromCache'}});
    const result = await pool.query(selectImage, vars);
    if (result.rowCount && result.rowCount > 0) {
      metrics.write(metric);
      // Cache hit
      return result.rows[0].url;
    }
    // Cache miss
    metrics.write(metric);
    return null;
  }

  async function addToCache(params, url, renderedAt) {
    const vars = [params.name,
      params.width,
      params.height,
      params.fit,
      params.mime,
      url,
      Boolean(params.blur),
      params.quality,
      renderedAt
    ];

    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'addToCache'}});
    try {
      const result = await pool.query(insertImage, vars);
      return result.rowCount === 1;
    } catch (e) {
      const message = e.toString();
      if (message.includes('duplicate key value violates unique constraint')) {
        // This is triggered if two images raced to be computed simultaneously and only one can be saved to the db
        // As a result, we do not consider this an error
        log('debug', 'Two images raced to be saved in the database. Persisted just one.');
        return true;
      } else {
        log('error', message);
      }
    } finally {
      metrics.write(metric);
    }
    return false;
  }

  function migrate(callback) {
    return pool.connect((err, client, done) => {
      if (err) {
        log('error', `error fetching client from pool ${err}`);
        callback(err);
        return;
      }
      const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'migrate'}});
      migrateAndStart(client, './db-migrations', () => {
        log('info', 'Database migrated to newest version');
        metrics.write(metric);
        done(null);
        callback(null);
      });
    });
  }

  function stats() {
    const {totalCount, idleCount, waitingCount} = pool;
    return {
      'db_maxCount': poolSize,
      'db_totalCount': totalCount,
      'db_idleCount': idleCount,
      'db_waitingCount': waitingCount,
      'db_inUseRatio': totalCount / poolSize,
      'db_idleRatio': idleCount / poolSize
    };
  }

  async function imagesCompletedAfter(threshold) {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'imagesCompletedAfter'}});
    const result = await pool.query(selectImageIds, [threshold.toISOString()]);
    metrics.write(metric);
    return result.rows;
  }

  async function getTokensWithoutUploadedAt() {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'getTokensWithoutUploadedAt'}});
    const result = await pool.query(emptyUploadedAt);
    metrics.write(metric);
    return result.rows;
  }

  async function setUploadedAt(imageId, value) {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'setUploadedAt'}});
    await pool.query(setUploadedAtIfEmpty, [imageId, value]);
    metrics.write(metric);
  }

  async function nextPendingAppMigration() {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'nextPendingAppMigration'}});
    const result = await pool.query(selectNextAppMigration);
    metrics.write(metric);
    if (result.rowCount === 1) {
      return result.rows[0].name;
    }
    return null;
  }

  async function markAppMigrationAsCompleted(name) {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'markAppMigrationAsCompleted'}});
    await pool.query(markMigrationAsCompleted, [name]);
    metrics.write(metric);
  }

  async function close() {
    const metric = timingMetric(DATABASE, {tags: {sqlOperation: 'close'}});
    const result = await pool.end();
    metrics.write(metric);
    return result;
  }

  return {
    migrate,
    close,
    isDbAlive,
    createToken,
    consumeToken,
    deleteTokenForImageId,
    cleanupTokens,
    addToCache,
    getFromCache,
    stats,
    imagesCompletedAfter,
    markUploadAsCompleted,
    getTokensWithoutUploadedAt,
    setUploadedAt,
    nextPendingAppMigration,
    markAppMigrationAsCompleted
  };
}
