/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

'use strict';

const RelayInMemoryRecordSource = require('RelayInMemoryRecordSource');
const RelayMarkSweepStore = require('RelayMarkSweepStore');
const RelayModernEnvironment = require('RelayModernEnvironment');
const RelayModernTestUtils = require('RelayModernTestUtils');
const RelayNetwork = require('RelayNetwork');
const RelayObservable = require('RelayObservable');
const RelayQueryResponseCache = require('RelayQueryResponseCache');
const RelayTestSchema = require('RelayTestSchema');

const areEqual = require('areEqual');
const invariant = require('invariant');

const MAX_SIZE = 10;
const MAX_TTL = 5 * 60 * 1000; // 5 min

function mockInstanceMethod(object, key) {
  object[key] = jest.fn(object[key].bind(object));
}

function mockDisposableMethod(object, key) {
  const fn = object[key].bind(object);
  object[key] = jest.fn((...args) => {
    const disposable = fn(...args);
    const dispose = jest.fn(() => disposable.dispose());
    object[key].mock.dispose = dispose;
    return {dispose};
  });
  const mockClear = object[key].mockClear.bind(object[key]);
  object[key].mockClear = () => {
    mockClear();
    object[key].mock.dispose = null;
  };
}

function mockObservableMethod(object, key) {
  const fn = object[key].bind(object);
  object[key] = jest.fn((...args) =>
    fn(...args).do({
      start: subscription => {
        object[key].mock.subscriptions.push(subscription);
      },
    }),
  );
  object[key].mock.subscriptions = [];
  const mockClear = object[key].mockClear.bind(object[key]);
  object[key].mockClear = () => {
    mockClear();
    object[key].mock.subscriptions = [];
  };
}

/**
 * Creates an instance of the `Environment` interface defined in
 * RelayStoreTypes with a mocked network layer.
 *
 * Usage:
 *
 * ```
 * const environment = RelayModernMockEnvironment.createMockEnvironment();
 * ```
 *
 * Mock API:
 *
 * Helpers are available as `environment.mock.<helper>`:
 *
 * - `compile(text: string): {[queryName]: Query}`: Create a query.
 * - `isLoading(query, variables): boolean`: Determine whether the given query
 *   is currently being loaded (not yet rejected/resolved).
 * - `reject(query, error: Error): void`: Reject a query that has been fetched
 *   by the environment.
 * - `resolve(query, payload: PayloadData): void`: Resolve a query that has been
 *   fetched by the environment.
 */
function createMockEnvironment(options: {
  schema?: ?GraphQLSchema,
  handlerProvider?: ?HandlerProvider,
}) {
  const schema = options && options.schema;
  const handlerProvider = options && options.handlerProvider;
  const source = new RelayInMemoryRecordSource();
  const store = new RelayMarkSweepStore(source);
  const cache = new RelayQueryResponseCache({
    size: MAX_SIZE,
    ttl: MAX_TTL,
  });

  // Mock the network layer
  let pendingRequests = [];
  const execute = (operation, variables, cacheConfig) => {
    const {id, text} = operation;
    const cacheID = id || text;

    let cachedPayload = null;
    if (!cacheConfig || !cacheConfig.force) {
      cachedPayload = cache.get(cacheID, variables);
    }
    if (cachedPayload !== null) {
      return RelayObservable.from(cachedPayload);
    }

    const request = {operation, variables, cacheConfig};
    pendingRequests = pendingRequests.concat([request]);

    return new RelayObservable(sink => {
      request.sink = sink;
      return () => {
        pendingRequests = pendingRequests.filter(
          pending => pending !== request,
        );
      };
    });
  };

  function getRequest(operation) {
    const request = pendingRequests.find(
      pending => pending.operation === operation,
    );
    invariant(
      request && request.sink,
      'MockEnvironment: Cannot respond to `%s`, it has not been requested yet.',
      operation.name,
    );
    return request;
  }

  function ensureValidPayload(payload) {
    invariant(
      typeof payload === 'object' &&
        payload !== null &&
        payload.hasOwnProperty('data'),
      'MockEnvironment(): Expected payload to be an object with a `data` key.',
    );
    return payload;
  }

  const cachePayload = (operation, variables, payload) => {
    const {id, text} = operation;
    const cacheID = id || text;
    cache.set(cacheID, variables, payload);
  };

  const clearCache = () => {
    cache.clear();
  };

  if (!schema) {
    global.__RELAYOSS__ = true;
  }

  // Helper to compile a query with the given schema (or the test schema by
  // default).
  const compile = text => {
    return RelayModernTestUtils.generateAndCompile(
      text,
      schema || RelayTestSchema,
    );
  };

  // Helper to determine if a given query/variables pair is pending
  const isLoading = (operation, variables, cacheConfig) => {
    return pendingRequests.some(
      pending =>
        pending.operation === operation &&
        areEqual(pending.variables, variables) &&
        areEqual(pending.cacheConfig, cacheConfig || {}),
    );
  };

  // Helpers to reject or resolve the payload for an individual operation.
  const reject = (operation, error) => {
    if (typeof error === 'string') {
      error = new Error(error);
    }
    getRequest(operation).sink.error(error);
  };

  const nextValue = (operation, payload) => {
    const request = getRequest(operation);
    request.sink.next({
      operation: request.operation,
      variables: request.variables,
      response: ensureValidPayload(payload),
    });
  };

  const complete = operation => {
    getRequest(operation).sink.complete();
  };

  const resolve = (operation, payload) => {
    const request = getRequest(operation);
    request.sink.next({
      operation: request.operation,
      variables: request.variables,
      response: ensureValidPayload(payload),
    });
    request.sink.complete();
  };

  // Mock instance
  const environment = new RelayModernEnvironment({
    configName: 'RelayModernMockEnvironment',
    handlerProvider,
    network: RelayNetwork.create(execute, execute),
    store,
  });
  // Mock all the functions with their original behavior
  mockDisposableMethod(environment, 'applyUpdate');
  mockInstanceMethod(environment, 'commitPayload');
  mockInstanceMethod(environment, 'getStore');
  mockInstanceMethod(environment, 'lookup');
  mockDisposableMethod(environment, 'subscribe');
  mockDisposableMethod(environment, 'retain');
  mockObservableMethod(environment, 'execute');
  mockObservableMethod(environment, 'executeMutation');

  mockInstanceMethod(store, 'getSource');
  mockInstanceMethod(store, 'lookup');
  mockInstanceMethod(store, 'notify');
  mockInstanceMethod(store, 'publish');
  mockDisposableMethod(store, 'retain');
  mockDisposableMethod(store, 'subscribe');

  environment.mock = {
    cachePayload,
    clearCache,
    compile,
    isLoading,
    reject,
    resolve,
    nextValue,
    complete,
  };

  environment.mockClear = () => {
    environment.applyUpdate.mockClear();
    environment.commitPayload.mockClear();
    environment.getStore.mockClear();
    environment.lookup.mockClear();
    environment.subscribe.mockClear();
    environment.retain.mockClear();
    environment.execute.mockClear();
    environment.executeMutation.mockClear();

    store.getSource.mockClear();
    store.lookup.mockClear();
    store.notify.mockClear();
    store.publish.mockClear();
    store.retain.mockClear();
    store.subscribe.mockClear();

    cache.clear();

    pendingRequests = [];
  };

  return environment;
}

module.exports = {createMockEnvironment};
