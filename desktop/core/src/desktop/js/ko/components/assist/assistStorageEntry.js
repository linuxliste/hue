// Licensed to Cloudera, Inc. under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  Cloudera, Inc. licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import $ from 'jquery';
import * as ko from 'knockout';

import apiHelper from 'api/apiHelper';
import huePubSub from 'utils/huePubSub';
import { findBrowserConnector, getRootFilePath } from 'config/hueConfig';

const PAGE_SIZE = 100;

const TYPE_SPECIFICS = {
  adls: {
    apiHelperFetchFunction: 'fetchAdlsPath',
    dblClickPubSubId: 'assist.dblClickAdlsItem'
  },
  abfs: {
    apiHelperFetchFunction: 'fetchAbfsPath',
    dblClickPubSubId: 'assist.dblClickAbfsItem'
  },
  hdfs: {
    apiHelperFetchFunction: 'fetchHdfsPath',
    dblClickPubSubId: 'assist.dblClickHdfsItem'
  },
  s3: {
    apiHelperFetchFunction: 'fetchS3Path',
    dblClickPubSubId: 'assist.dblClickS3Item'
  },
  ofs: {
    apiHelperFetchFunction: 'fetchOfsPath',
    dblClickPubSubId: 'assist.dblClickOfsItem'
  }
};

class AssistStorageEntry {
  /**
   * @param {object} options
   * @param {object} options.definition
   * @param {string} options.definition.name
   * @param {string} options.definition.type (file, dir)
   * @param {string} options.source - The storage source
   * @param {string} [options.originalType] - The original storage type ('adl', 's3a')
   * @param {AssistStorageEntry} options.parent
   * @constructor
   */
  constructor(options) {
    const self = this;
    self.source = options.source;
    self.originalType = options.originalType;
    self.definition = options.definition;
    self.parent = options.parent;
    self.rootPath = options.rootPath || '';
    self.path = '';
    if (self.parent !== null) {
      self.path = self.parent.path;
      if (self.parent.path !== '/' && !/\/$/.test(self.path)) {
        self.path += '/';
      }
    }

    self.path += self.definition.name;
    self.abfsPath = (/^\//.test(self.path) ? 'abfs:/' : 'abfs://') + self.path;

    self.currentPage = 1;
    self.hasMorePages = true;
    self.preview = ko.observable();
    self.contextPopoverVisible = ko.observable(false);

    self.filter = ko.observable('').extend({ rateLimit: 400 });

    self.filter.subscribe(() => {
      self.currentPage = 1;
      self.hasMorePages = true;
      self.loadEntries();
    });

    self.entries = ko.observableArray([]);

    self.loaded = false;
    self.loading = ko.observable(false);
    self.loadingMore = ko.observable(false);
    self.errorText = ko.observable();
    self.hasErrors = ko.observable(false);
    self.open = ko.observable(false);

    self.open.subscribe(newValue => {
      if (newValue && self.entries().length === 0) {
        if (self.definition.type === 'dir') {
          self.loadEntries();
        } else {
          self.loadPreview();
        }
      }
    });

    self.hasEntries = ko.pureComputed(() => self.entries().length > 0);
  }

  dblClick() {
    huePubSub.publish(TYPE_SPECIFICS[self.source.type].dblClickPubSubId, this);
  }

  loadPreview() {
    const self = this;
    self.loading(true);
    apiHelper
      .fetchStoragePreview({
        path: self.getHierarchy(),
        type: self.source.type,
        silenceErrors: true
      })
      .done(data => {
        self.preview(data);
      })
      .fail(errorText => {
        self.hasErrors(true);
        self.errorText(errorText);
      })
      .always(() => {
        self.loading(false);
      });
  }

  loadEntries(callback) {
    const self = this;
    if (self.loading()) {
      return;
    }
    self.loading(true);
    self.hasErrors(false);

    apiHelper[TYPE_SPECIFICS[self.source.type].apiHelperFetchFunction]({
      pageSize: PAGE_SIZE,
      page: self.currentPage,
      filter: self.filter().trim() ? self.filter() : undefined,
      pathParts: self.getHierarchy(),
      rootPath: self.rootPath,
      successCallback: data => {
        self.hasMorePages = data.page.next_page_number > self.currentPage;
        const filteredFiles = data.files.filter(file => file.name !== '.' && file.name !== '..');
        self.entries(
          filteredFiles.map(file => {
            return new AssistStorageEntry({
              originalType: self.originalType,
              rootPath: self.rootPath,
              source: self.source,
              definition: file,
              parent: self
            });
          })
        );
        self.loaded = true;
        self.loading(false);
        self.hasErrors(!!data.s3_listing_not_allowed); // Special case where we want errors inline instead of the default popover. We don't want errorCallback handling
        self.errorText(data.s3_listing_not_allowed);
        if (callback) {
          callback();
        }
      },
      errorCallback: errorText => {
        self.hasErrors(true);
        self.errorText(errorText);
        self.loading(false);
        if (callback) {
          callback();
        }
      }
    });
  }

  goHome() {
    huePubSub.publish('assist.storage.go.home');
  }

  loadDeep(folders, callback) {
    const self = this;

    if (folders.length === 0) {
      callback(self);
      return;
    }

    if (this.rootPath) {
      const relativeFolders = folders.join('/').replace(new RegExp('^' + this.rootPath, ''), '');
      folders = relativeFolders.split('/');
    }

    const nextName = folders.shift();
    let loadedPages = 0;

    const findNextAndLoadDeep = () => {
      const foundEntry = self.entries().filter(entry => entry.definition.name === nextName);
      const passedAlphabetically =
        self.entries().length > 0 &&
        self.entries()[self.entries().length - 1].definition.name.localeCompare(nextName) > 0;

      if (foundEntry.length === 1) {
        foundEntry[0].loadDeep(folders, callback);
      } else if (!passedAlphabetically && self.hasMorePages && loadedPages < 50) {
        loadedPages++;
        self.fetchMore(findNextAndLoadDeep, () => {
          callback(self);
        });
      } else {
        callback(self);
      }
    };

    if (!self.loaded) {
      self.loadEntries(findNextAndLoadDeep);
    } else {
      findNextAndLoadDeep();
    }
  }

  getHierarchy() {
    const self = this;
    let parts = [];
    let entry = self;
    while (entry) {
      if (!entry.parent && entry.definition.name) {
        const rootParts = entry.definition.name.split('/').filter(Boolean);
        rootParts.reverse();
        parts = parts.concat(rootParts);
      } else if (entry.definition.name) {
        parts.push(entry.definition.name);
      }
      entry = entry.parent;
    }
    parts.reverse();
    return parts;
  }

  toggleOpen(data, event) {
    const self = this;
    if (self.definition.type === 'file') {
      if (event.ctrlKey || event.metaKey || event.which === 2) {
        window.open('/hue' + self.definition.url, '_blank');
      } else {
        huePubSub.publish('open.link', self.definition.url);
      }
      return;
    }
    self.open(!self.open());
    if (self.definition.name === '..') {
      if (self.parent.parent) {
        huePubSub.publish('assist.selectStorageEntry', self.parent.parent);
      }
    } else {
      huePubSub.publish('assist.selectStorageEntry', self);
    }
  }

  fetchMore(successCallback, errorCallback) {
    const self = this;
    if (!self.hasMorePages || self.loadingMore()) {
      return;
    }
    self.currentPage++;
    self.loadingMore(true);
    self.hasErrors(false);

    apiHelper[TYPE_SPECIFICS[self.source.type].apiHelperFetchFunction]({
      pageSize: PAGE_SIZE,
      page: self.currentPage,
      filter: self.filter().trim() ? self.filter() : undefined,
      pathParts: self.getHierarchy(),
      successCallback: data => {
        self.hasMorePages = data.page.next_page_number > self.currentPage;
        const filteredFiles = data.files.filter(file => file.name !== '.' && file.name !== '..');
        self.entries(
          self.entries().concat(
            filteredFiles.map(
              file =>
                new AssistStorageEntry({
                  originalType: self.originalType,
                  rootPath: self.rootPath,
                  source: self.source,
                  definition: file,
                  parent: self
                })
            )
          )
        );
        self.loadingMore(false);
        if (successCallback) {
          successCallback();
        }
      },
      errorCallback: () => {
        self.hasErrors(true);
        if (errorCallback) {
          errorCallback();
        }
      }
    });
  }

  showContextPopover(entry, event, positionAdjustment) {
    const $source = $(event.target);
    const offset = $source.offset();
    entry.contextPopoverVisible(true);

    if (positionAdjustment) {
      offset.left += positionAdjustment.left;
      offset.top += positionAdjustment.top;
    }

    huePubSub.publish('context.popover.show', {
      data: {
        type: 'storageEntry',
        storageEntry: entry
      },
      pinEnabled: true,
      orientation: 'right',
      source: {
        element: event.target,
        left: offset.left,
        top: offset.top - 3,
        right: offset.left + $source.width() + 3,
        bottom: offset.top + $source.height() - 3
      }
    });

    huePubSub.subscribeOnce('context.popover.hidden', () => {
      entry.contextPopoverVisible(false);
    });
  }

  openInImporter() {
    huePubSub.publish('open.in.importer', this.definition.path);
  }

  /**
   * Helper function to create an assistStorageEntry. It will load the entries starting from the root up until the
   * path or stop when a part is not found.
   *
   * @param {string} path - The path, can include the type i.e. '/tmp' or 's3:/tmp'.
   * @param {string} [type] - Optional type, if not specified here or in the path 'hdfs' will be used.
   * @return {JQueryPromise<AssistStorageEntry>}
   */
  static getEntry(path, type) {
    const deferred = $.Deferred();
    const typeMatch = path.match(/^([^:]+):\/(\/.*)\/?/i);
    type = typeMatch ? typeMatch[1] : type || 'hdfs';
    type = type.replace(/s3.*/i, 's3');
    type = type.replace(/adl.*/i, 'adls');
    type = type.replace(/abfs.*/i, 'abfs');
    type = type.replace(/ofs.*/i, 'ofs');

    // TODO: connector.id for browser connectors
    const connector = findBrowserConnector(connector => connector.type === type);
    if (connector) {
      const rootPath = getRootFilePath(connector);
      const rootEntry = new AssistStorageEntry({
        source: connector,
        rootPath: rootPath,
        originalType: typeMatch && typeMatch[1],
        definition: {
          name: rootPath,
          type: 'dir'
        },
        parent: null,
        apiHelper: apiHelper
      });

      if (type === 'abfs' || type === 'adls') {
        // ABFS / ADLS can have domain name in path. To prevent regression with s3 which allow periods in bucket name handle separately.
        const azureMatch = path.match(
          /^([^:]+):\/(\/((\w+)@)?[\w]+([\-\.]{1}\w+)*\.[\w]*)?(\/.*)?\/?/i
        );
        path = (azureMatch ? azureMatch[6] || '' : path).replace(/(?:^\/)|(?:\/$)/g, '').split('/');
        if (azureMatch && azureMatch[4]) {
          path.unshift(azureMatch[4]);
        }
      } else {
        path = (typeMatch ? typeMatch[2] : path).replace(/(?:^\/)|(?:\/$)/g, '').split('/');
      }

      rootEntry.loadDeep(path, deferred.resolve);
    } else {
      deferred.reject();
    }

    return deferred.promise();
  }
}

export default AssistStorageEntry;
