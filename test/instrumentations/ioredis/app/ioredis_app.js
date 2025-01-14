const Redis = require('ioredis');
const http = require('http');
const url = require('url');
require('log-timestamp');

const DEFAULT_REDIS_HOST = 'localhost';
const DEFAULT_REDIS_PORT = 6379;

const host = 'localhost';
let httpServer;

async function openRedisConnection(host, port) {
  return new Redis({
    host,
    port,
  });
}

function respond(res, status, body) {
  console.log(`responding with ${status} ${JSON.stringify(body)}`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

const requestListener = async function (req, res) {
  console.error(`Received request: ${req.method} ${req.url}`);

  const requestUrl = url.parse(req.url, true);
  const host = requestUrl?.query?.host || DEFAULT_REDIS_HOST;
  const port = Number(requestUrl?.query?.port || DEFAULT_REDIS_PORT);
  const key = requestUrl?.query?.key || 'test:key:default';
  const field = requestUrl?.query?.field || 'test:field:default';
  const value = requestUrl?.query?.value || 'Hello World!';

  let client;
  switch (requestUrl.pathname) {
    case '/set':
      try {
        client = await openRedisConnection(host, port);
        await client.set(key, value);
        respond(res, 200, {});
      } catch (err) {
        console.error(`Error setting key value`, err);
        respond(res, 500, { error: err });
      }
      break;

    case '/hset':
      try {
        client = await openRedisConnection(host, port);
        await client.hset(key, field, value);
        respond(res, 200, {});
      } catch (err) {
        console.error(`Error setting hash field value`, err);
        respond(res, 500, { error: err });
      }
      break;

    case '/hmset':
      try {
        client = await openRedisConnection(host, port);
        const obj = {
          [requestUrl?.query?.fieldA]: requestUrl?.query?.valueA,
          [requestUrl?.query?.fieldB]: requestUrl?.query?.valueB,
        };
        await client.hmset(key, [...Object.entries(obj).flat()]);
        respond(res, 200, {});
      } catch (err) {
        console.error(`Error setting hash field values`, err);
        respond(res, 500, { error: err });
      }
      break;

    case '/get':
      try {
        client = await openRedisConnection(host, port);
        const retrievedValue = await client.get(key);
        if (retrievedValue !== value) {
          throw new Error(
            `Retrieved value '${retrievedValue}' does not match expected value '${value}'`
          );
        }
        respond(res, 200, {});
      } catch (err) {
        console.error(`Error getting key value`, err);
        respond(res, 500, { error: err });
      }
      break;

    case '/hgetall':
      try {
        client = await openRedisConnection(host, port);
        await client.hgetall(key);
        respond(res, 200, {});
      } catch (err) {
        console.error(`Error getting key value`, err);
        respond(res, 500, { error: err });
      }
      break;

    case '/transaction-set-and-get':
      try {
        client = await openRedisConnection(host, port);
        const preKeyValue = `pre-${value}`;
        const unknownKey = `unknown-${key}`;
        const [setPreKeyReply, getPreKeyValue, setKeyReply, getKeyValue, getUnknownKeyValue] =
          await client
            .pipeline()
            .set(key, preKeyValue)
            .get(key)
            .set(key, value)
            .get(key)
            .get(unknownKey)
            .exec();
        if (setPreKeyReply[1] != 'OK') {
          throw new Error(`Set pre-key failed with response '${setPreKeyReply}'`);
        }
        if (getPreKeyValue[1] != preKeyValue) {
          throw new Error(
            `Get pre-key value returned '${getPreKeyValue}' when '${preKeyValue}' was expected`
          );
        }
        if (setKeyReply[1] != 'OK') {
          throw new Error(`Set key reply failed with response '${setKeyReply}'`);
        }
        if (getKeyValue[1] != value) {
          throw new Error(`Get key value returned '${getKeyValue}' when '${value}' was expected`);
        }
        if (getUnknownKeyValue[1]) {
          throw new Error(`Unexpected value '${getUnknownKeyValue}' for unknown key`);
        }
        respond(res, 200, {});
      } catch (err) {
        console.error(`Error in transaction`, err);
        respond(res, 500, { error: err });
      }
      break;

    default:
      respond(res, 404, { error: 'Resource not found' });
  }

  if (client) {
    await client.quit();
  }
};

httpServer = http.createServer(requestListener);
httpServer.listen(0, host, () => {
  const port = httpServer.address().port;
  console.error(`HTTP server listening on port ${port}`);
  if (process.send) {
    process.send(port);
  }
});
