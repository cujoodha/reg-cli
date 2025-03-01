/* @flow */

import glob from 'glob'; // $FlowIgnore
import mkdirp from 'make-dir'; // $FlowIgnore
import del from 'del'; // $FlowIgnore
import fs from 'fs';
import path from 'path';
import { range } from 'lodash';
import log from './log';
import createReport from './report';
// $FlowIgnore
import bluebird from 'bluebird';
import EventEmitter from 'events';
import ProcessAdaptor from './process-adaptor';
import type { DiffCreatorParams } from './diff';

const IMAGE_FILES = '/**/*.+(tiff|jpeg|jpg|gif|png|bmp)';

type CompareResult = {
  passed: boolean,
  image: string,
};

type RegParams = {
  actualDir: string,
  expectedDir: string,
  diffDir: string,
  report?: string,
  json?: string,
  update?: boolean,
  urlPrefix?: string,
  matchingThreshold?: number,
  threshold?: number, // alias to thresholdRate.
  thresholdRate?: number,
  thresholdPixel?: number,
  concurrency?: number,
  enableAntialias?: boolean,
  enableClientAdditionalDetection?: boolean,
};

const difference = (arrA, arrB) => arrA.filter(a => !arrB.includes(a));

const copyImages = (actualImages, { expectedDir, actualDir }) => {
  return Promise.all(
    actualImages.map(
      image =>
        new Promise((resolve, reject) => {
          try {
            mkdirp.sync(path.dirname(path.join(expectedDir, image)));
            const writeStream = fs.createWriteStream(path.join(expectedDir, image));
            fs.createReadStream(path.join(actualDir, image)).pipe(writeStream);
            writeStream.on('finish', err => {
              if (err) reject(err);
              resolve();
            });
          } catch (err) {
            reject(err);
          }
        }),
    ),
  );
};

const compareImages = (
  emitter,
  { expectedImages, actualImages, dirs, matchingThreshold, thresholdPixel, thresholdRate, concurrency, enableAntialias },
): Promise<CompareResult[]> => {
  const images = actualImages.filter(actualImage => expectedImages.includes(actualImage));
  concurrency = images.length < 20 ? 1 : concurrency || 4;
  const processes = range(concurrency).map(() => new ProcessAdaptor(emitter));
  return bluebird
    .map(
      images,
      image => {
        const p = processes.find(p => !p.isRunning());
        if (p) {
          return p.run({
            ...dirs,
            image,
            matchingThreshold,
            thresholdRate,
            thresholdPixel,
            enableAntialias,
          });
        }
      },
      { concurrency },
    )
    .then(result => {
      processes.forEach(p => p.close());
      return result;
    })
    .filter(r => !!r);
};

const cleanupExpectedDir = (expectedDir, changedFiles) => {
  const paths = changedFiles.map(image => path.join(expectedDir, image));
  del(paths);
};

const aggregate = result => {
  const passed = result.filter(r => r.passed).map(r => r.image);
  const failed = result.filter(r => !r.passed).map(r => r.image);
  const diffItems = failed.map(image => image.replace(/\.[^\.]+$/, '.png'));
  return { passed, failed, diffItems };
};

const updateExpected = ({ actualDir, expectedDir, diffDir, deletedImages, newImages, diffItems }) => {
  cleanupExpectedDir(expectedDir, [...deletedImages, ...diffItems]);
  return copyImages([...newImages, ...diffItems], {
    actualDir,
    expectedDir,
    diffDir,
  }).then(() => {
    log.success(`\nAll images are updated. `);
  });
};

module.exports = (params: RegParams) => {
  const {
    actualDir,
    expectedDir,
    diffDir,
    json,
    concurrency,
    update,
    report,
    urlPrefix,
    threshold,
    matchingThreshold,
    thresholdRate,
    thresholdPixel,
    enableAntialias,
    enableClientAdditionalDetection,
  } = params;
  const dirs = { actualDir, expectedDir, diffDir };
  const emitter = new EventEmitter();
  const expectedImages = glob.sync(`${expectedDir}${IMAGE_FILES}`).map(p => path.relative(expectedDir, p)).map(p => p[0] === path.sep ? p.slice(1) : p);
  const actualImages = glob.sync(`${actualDir}${IMAGE_FILES}`).map(p => path.relative(actualDir, p)).map(p => p[0] === path.sep ? p.slice(1) : p);
  const deletedImages = difference(expectedImages, actualImages);
  const newImages = difference(actualImages, expectedImages);
  mkdirp.sync(expectedDir);
  mkdirp.sync(diffDir);

  setImmediate(() => emitter.emit('start'));
  compareImages(emitter, {
    expectedImages,
    actualImages,
    dirs,
    matchingThreshold,
    thresholdRate: thresholdRate || threshold,
    thresholdPixel,
    concurrency,
    enableAntialias: !!enableAntialias,
  })
    .then(result => aggregate(result))
    .then(({ passed, failed, diffItems }) => {
      return createReport({
        passedItems: passed,
        failedItems: failed,
        newItems: newImages,
        deletedItems: deletedImages,
        expectedItems: update ? actualImages : expectedImages,
        previousExpectedImages: expectedImages,
        actualItems: actualImages,
        diffItems,
        json: json || './reg.json',
        actualDir,
        expectedDir,
        diffDir,
        report: report || '',
        urlPrefix: urlPrefix || '',
        enableClientAdditionalDetection: !!enableClientAdditionalDetection,
      });
    })
    .then(result => {
      deletedImages.forEach(image => emitter.emit('compare', { type: 'delete', path: image }));
      newImages.forEach(image => emitter.emit('compare', { type: 'new', path: image }));
      if (update) {
        return updateExpected({
          actualDir,
          expectedDir,
          diffDir,
          deletedImages,
          newImages,
          diffItems: result.diffItems,
        }).then(() => {
          emitter.emit('update');
          return result;
        });
      }
      return result;
    })
    .then(result => emitter.emit('complete', result))
    .catch(err => emitter.emit('error', err));

  return emitter;
};
