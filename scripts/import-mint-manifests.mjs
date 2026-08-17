#!/usr/bin/env node
/**
 * One-shot importer for this project's Mint artifact manifests.
 *
 * The manifests below were returned by Mint MCP `get_asset_artifact_manifests`
 * and are recorded here so the download step is reproducible without re-running
 * agent tooling. Each entry is written to a temporary manifest file and handed
 * to the canonical `sync-mint-assets.mjs`, which downloads the files and
 * updates `mint-assets.json` under a stable logical key.
 *
 *   node scripts/import-mint-manifests.mjs <path-to-sync-mint-assets.mjs>
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CDN = 'https://cdn.mint.gg';

/** [logicalKey, assetId, slug, glbHash, previewHash, byteSize] */
const MODELS = [
  ['ship-hull', 'ks71fhvyzn2k77aw83hp9s8r018cmn5v', 'conestoga-fusion-hauler', '018cmn5v', '5e1bad6a9d050058', 'c841cc64b767fb71', 1071280],
  ['drive-core', 'ks7b9p5597shx8fcrnk56wkk5d8cnb06', 'charred-pulse-core', '5d8cnb06', '4f89276f3f12b545', '583f42ee47ed1bab', 1035276],

  ['debris-01', 'ks783wrwbnqx20nh3ynjhfcg8d8cmt0d', 'dead-comsat', '8d8cmt0d', '7fde62ec0d2448ed', '1daf2264a3b64f42', 1217736],
  ['debris-02', 'ks75hq31ssjns9zyvf177wkspx8cm0cv', 'spent-rocket-stage', 'px8cm0cv', '566d6cb3c7ee1b99', '6d17ad1d8ec1c9be', 1040188],
  ['debris-03', 'ks7cfkz434gqa5pva3pfgnsk2x8cnxdc', 'torn-solar-array', '2x8cnxdc', '7b17c92927389b52', '2dda1fa8b82cf166', 1060816],
  ['debris-04', 'ks7c0zvg2z8a5hm23tgdq5yjyh8cmz7x', 'tumbling-hull-section', 'yh8cmz7x', '84695e3a54640f1a', '448381a503ac8bf0', 915316],
  ['debris-05', 'ks76e5wme4gqh7k1tmsg93h6518cm2cp', 'docking-ring-fragment', '518cm2cp', '0ee3d99a1426f567', '3ddf3207111ed24e', 1222224],
  ['debris-06', 'ks7717h79f62496shed5ntz1ed8cmbrm', 'debris-cluster', 'ed8cmbrm', 'bbaa35ccfe6734ff', '43742abb86092b9b', 1220828],

  ['asteroid-01', 'ks7bm1may9p4mn86zf23fja4gs8cnq2q', 'large-carbonaceous-asteroid', 'gs8cnq2q', 'a4c165ed5cdc3459', 'd016416a011337e1', 414100],
  ['asteroid-02', 'ks75zwafbcrssxmxt11mffn2zx8cm68f', 'medium-iron-asteroid', 'zx8cm68f', '889d3d75a8d6fc20', 'cabc19be619d8cb1', 831056],
  ['asteroid-03', 'ks7cbazac29hcn54s5t7pefhv18cm6tp', 'small-rubble-rock', 'v18cm6tp', '7a043b3390f4f678', '913f4f8234acd465', 605444],
  ['asteroid-04', 'ks7cmf8wt465628xbk2t2zps7h8cnn13', 'dirty-ice-fragment', '7h8cnn13', '2113811cdc53c80f', 'cbca5a787fb90c1b', 658140],
  ['asteroid-05', 'ks7fj27v48mcqprtcn684n2qk58cn0tm', 'split-boulder', 'k58cn0tm', '10e1844af8baffdd', 'c7782f3dc355cd2d', 577128],
  ['asteroid-06', 'ks71b5k41qxrcva0k31p15qhvs8cmw4r', 'ice-capped-rock', 'vs8cmw4r', 'fd79ba2e7aa2f13a', 'f2af1d44528d2e7c', 645864],

  ['station-01', 'ks720kzfkqdfr7den3fkyek2vd8cnqxt', 'leo-transfer-ring', 'vd8cnqxt', '95bacec836a9194a', '300723266b7a65cc', 1244456],
  ['station-02', 'ks765gfndnqqq27az9ws87waw58cmy0p', 'lunar-gateway', 'w58cmy0p', '2da4808ea9f6ce2e', '61c44b4b0fe525b7', 1164724],
  ['station-03', 'ks720gjkwbse422v856nkg35qd8cn6z5', 'l1-waystation', 'qd8cn6z5', '778ece10ca745c58', 'c0eb9e6c65957c08', 1014016],
  ['station-04', 'ks761wd9fyvcwws9a158xm08s98cmt9x', 'ceres-depot', 's98cmt9x', '62ed73eca673bd38', 'e0d797e8ac9a314a', 970056],
  ['station-05', 'ks7cnzt0aj80yt9c9tjgw9hevn8cnjb8', 'phobos-station', 'vn8cnjb8', '55bd8bfbc18aa91a', '05136e8a94610152', 955364],
];

/** [logicalKey, assetId, filename, urlSlug, urlHash, byteSize] */
const IMAGES = [
  ['crew-portrait-1', 'xn73h8vxdrgqm8rppbkgd4284n8cn2rd', 'Crew-Portrait-Thompson-6321d2.png', 'crew-portrait-thompson-6321d2', '9f42e7700c9122e6', 1171004],
  ['crew-portrait-2', 'xn7cfewah09z0s206zh7pfy9x18cm52p', 'Crew-Portrait-Helen-bf89be.png', 'crew-portrait-helen-bf89be', '36f4b3e3890359aa', 891836],
  ['crew-portrait-3', 'xn7ethpgjgxpvgbnz7fsz9gx2x8cm6xw', 'Crew-Portrait-Jane-9a20ce.png', 'crew-portrait-jane-9a20ce', 'b1f8928e4832ed09', 1083050],
  ['crew-portrait-4', 'xn7e1yww3v4cn8bamx557dfkm98cm5c2', 'Crew-Portrait-Jethro-78322a.png', 'crew-portrait-jethro-78322a', 'c752ed88d47d5881', 1059825],
  ['crew-portrait-5', 'xn786yqjthxvxntmaw2fqy1qvx8cnr77', 'Crew-Portrait-Steelah-6506b7.png', 'crew-portrait-steelah-6506b7', 'c9dc764e1c5da0aa', 999609],
];

/** [logicalKey, assetId, filename, urlSlug, urlHash, byteSize, durationSeconds] */
const AUDIO = [
  ['audio-drive-hum', 'xd7e68eg3jss5ydyzn4s2bynph8cnkp3', 'Drive-Hum-Loop-9a58d6.mp3', 'drive-hum-loop-9a58d6', '4b45e37f2ad35b44', 321036, 20],
  ['audio-klaxon', 'xd7347tctr25yw7kf6j00vzypd8cnje5', 'Hazard-Klaxon-1d14d0.mp3', 'hazard-klaxon-1d14d0', '86f0a6dc35cc414b', 33062, 2],
];

function modelManifest([, assetId, slug, idSuffix, glbHash, previewHash, byteSize]) {
  return {
    manifestVersion: 1,
    source: { kind: 'asset', assetType: 'model', id: assetId },
    artifacts: [
      {
        id: 'original_glb',
        artifactId: 'original_glb',
        label: 'Original GLB',
        kind: 'original_model',
        role: 'canonical_model',
        format: 'glb',
        filename: `${slug}-${idSuffix}-original.glb`,
        contentType: 'model/gltf-binary',
        byteSize,
        downloadUrl: `${CDN}/glb/${slug}-normalized-${glbHash}.glb`,
        suggestedPath: `public/models/${slug}-${idSuffix}-original.glb`,
        loaderHint: 'gltf',
      },
      {
        id: 'preview_image',
        artifactId: 'preview_image',
        label: 'Preview Image',
        kind: 'asset_preview',
        role: 'preview_image',
        format: 'webp',
        filename: `${slug}-${idSuffix}-preview.webp`,
        contentType: 'image/webp',
        downloadUrl: `${CDN}/images/models/${slug}-${previewHash}.webp`,
        suggestedPath: `public/images/${slug}-${idSuffix}-preview.webp`,
        loaderHint: 'image',
      },
    ],
  };
}

function imageManifest([, assetId, filename, urlSlug, urlHash, byteSize]) {
  return {
    manifestVersion: 1,
    source: { kind: 'asset', assetType: 'image', id: assetId },
    artifacts: [
      {
        id: 'image_file',
        artifactId: 'image_file',
        label: 'Image File',
        kind: 'image_file',
        role: 'image',
        format: 'png',
        filename,
        contentType: 'image/png',
        byteSize,
        width: 1024,
        height: 1024,
        aspectRatio: 1,
        downloadUrl: `${CDN}/images/${assetId}/${urlSlug}-${urlHash}.png`,
        suggestedPath: `public/images/${filename}`,
        loaderHint: 'image',
      },
    ],
  };
}

function audioManifest([, assetId, filename, urlSlug, urlHash, byteSize, durationSeconds]) {
  return {
    manifestVersion: 1,
    source: { kind: 'asset', assetType: 'audio', id: assetId },
    artifacts: [
      {
        id: 'audio_file',
        artifactId: 'audio_file',
        label: 'Audio File',
        kind: 'audio_file',
        role: 'audio',
        format: 'mp3',
        filename,
        contentType: 'audio/mpeg',
        byteSize,
        durationSeconds,
        downloadUrl: `${CDN}/audio/${assetId}/${urlSlug}-${urlHash}.mp3`,
        suggestedPath: `public/audio/${filename}`,
        loaderHint: 'audio',
      },
    ],
  };
}

function runSync(syncScript, manifestPath, key) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [syncScript, '--project', '.', '--manifest', manifestPath, '--key', key],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`sync failed for ${key} (exit ${code}):\n${out}`));
    });
  });
}

const syncScript = process.argv[2];
if (!syncScript) {
  console.error('Usage: node scripts/import-mint-manifests.mjs <path-to-sync-mint-assets.mjs>');
  process.exit(1);
}

const work = [
  ...MODELS.map((row) => [row[0], modelManifest(row)]),
  ...IMAGES.map((row) => [row[0], imageManifest(row)]),
  ...AUDIO.map((row) => [row[0], audioManifest(row)]),
];

const scratch = await mkdtemp(path.join(tmpdir(), 'mint-manifests-'));
let failures = 0;

try {
  for (const [key, manifest] of work) {
    const file = path.join(scratch, `${key}.json`);
    await writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
    try {
      await runSync(syncScript, file, key);
      console.log(`  ok   ${key}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${key}: ${error.message}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(`\n${work.length - failures}/${work.length} assets synced.`);
process.exit(failures > 0 ? 1 : 0);
