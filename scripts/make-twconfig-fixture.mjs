// One-off helper to build a test sb3 with a TurboWasp // _twconfig_
// comment embedded in project.json so we can exercise the merge flow
// in the dev server. Run with `node scripts/make-twconfig-fixture.mjs`.
import { writeFileSync } from 'node:fs';
import JSZip from 'jszip';

const commentText = [
  'Configuration for https://turbowarp.org/',
  'You can move, resize, and minimize this comment, but don\'t edit it by hand. This comment can be deleted to remove the stored settings.',
  '{"framerate":60,"runtimeOptions":{"miscLimits":false},"hq":true,"width":480,"height":270} // _twconfig_',
].join('\n');

const project = {
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {
        twconfigComment: {
          blockId: null,
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          minimized: false,
          text: commentText,
        },
      },
      currentCostume: 0,
      costumes: [
        {
          name: 'blank',
          dataFormat: 'svg',
          assetId: '78f1c8994065bafc771e04e2af4f7453',
          md5ext: '78f1c8994065bafc771e04e2af4f7453.svg',
          rotationCenterX: 0,
          rotationCenterY: 0,
        },
      ],
      sounds: [],
      volume: 100,
      layerOrder: 0,
      videoTransparency: 50,
      videoState: 'on',
      textToSpeechLanguage: null,
    },
  ],
  monitors: [],
  extensions: [],
  extensionURLs: {},
  meta: {
    semver: '3.0.0',
    vm: '0.2.0',
    agent: '',
    platform: { name: 'TurboWarp', url: 'https://turbowarp.org/' },
  },
};

const zip = new JSZip();
zip.file('project.json', JSON.stringify(project));
const buf = await zip.generateAsync({ type: 'arraybuffer' });
writeFileSync(new URL('../test-fixtures/twconfig-fixture.sb3', import.meta.url), Buffer.from(buf));
console.log('Wrote test-fixtures/twconfig-fixture.sb3', buf.byteLength, 'bytes');
