/* @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {property} from 'lit/decorators.js';
// import {Object3D, Event as ThreeEvent} from 'three';
import {USDZExporter} from 'three/examples/jsm/exporters/USDZExporter.js';
// import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {IS_AR_QUICKLOOK_CANDIDATE, IS_SCENEVIEWER_CANDIDATE, IS_WEBXR_AR_CANDIDATE} from '../constants.js';
import ModelViewerElementBase, {$needsRender, $progressTracker, $renderer, $scene, $shouldAttemptPreload, $updateSource} from '../model-viewer-base.js';
import {enumerationDeserializer} from '../styles/deserializers.js';
import {ARStatus, ARTracking} from '../three-components/ARRenderer.js';
import {Constructor, waitForEvent} from '../utilities.js';

let isWebXRBlocked = false;
let isSceneViewerBlocked = false;
const noArViewerSigil = '#model-viewer-no-ar-fallback';

export type ARMode = 'quick-look'|'scene-viewer'|'webxr'|'none';

const deserializeARModes = enumerationDeserializer<ARMode>(
    ['quick-look', 'scene-viewer', 'webxr', 'none']);

const DEFAULT_AR_MODES = 'webxr scene-viewer quick-look';

const ARMode: {[index: string]: ARMode} = {
  QUICK_LOOK: 'quick-look',
  SCENE_VIEWER: 'scene-viewer',
  WEBXR: 'webxr',
  NONE: 'none'
};

export interface ARStatusDetails {
  status: ARStatus;
}

export interface ARTrackingDetails {
  status: ARTracking;
}

const $arButtonContainer = Symbol('arButtonContainer');
const $enterARWithWebXR = Symbol('enterARWithWebXR');
export const $openSceneViewer = Symbol('openSceneViewer');
export const $openIOSARQuickLook = Symbol('openIOSARQuickLook');
const $canActivateAR = Symbol('canActivateAR');
const $arMode = Symbol('arMode');
const $arModes = Symbol('arModes');
const $arAnchor = Symbol('arAnchor');
const $preload = Symbol('preload');

const $onARButtonContainerClick = Symbol('onARButtonContainerClick');
const $onARStatus = Symbol('onARStatus');
const $onARTracking = Symbol('onARTracking');
const $onARTap = Symbol('onARTap');
const $selectARMode = Symbol('selectARMode');
const $triggerLoad = Symbol('triggerLoad');

export declare interface ARInterface {
  ar: boolean;
  arModes: string;
  arScale: string;
  arPlacement: string;
  iosSrc: string|null;
  xrEnvironment: boolean;
  readonly canActivateAR: boolean;
  activateAR(): Promise<void>;
}

export const ARMixin = <T extends Constructor<ModelViewerElementBase>>(
    ModelViewerElement: T): Constructor<ARInterface>&T => {
  class ARModelViewerElement extends ModelViewerElement {
    @property({type: Boolean, attribute: 'ar'}) ar: boolean = false;

    @property({type: String, attribute: 'ar-scale'}) arScale: string = 'auto';

    @property({type: String, attribute: 'ar-placement'})
    arPlacement: string = 'floor';

    @property({type: String, attribute: 'ar-modes'})
    arModes: string = DEFAULT_AR_MODES;

    @property({type: String, attribute: 'ios-src'}) iosSrc: string|null = null;
    @property({type: String}) _zarboAndroidSrc: string = '';
    @property({type: String}) _zarbo3dSrc: string = '';
    @property({type: String}) _temp_src: string | null = null;
    @property({type: String}) _zarboIosSrc: string = '';

    @property({type: Boolean, attribute: 'xr-environment'})
    xrEnvironment: boolean = false;

    get canActivateAR(): boolean {
      return this[$arMode] !== ARMode.NONE;
    }

    protected[$canActivateAR]: boolean = false;

    // TODO: Add this to the shadow root as part of this mixin's
    // implementation:
    protected[$arButtonContainer]: HTMLElement =
        this.shadowRoot!.querySelector('.ar-button') as HTMLElement;

    protected[$arAnchor] = document.createElement('a');

    protected[$arModes]: Set<ARMode> = new Set();
    protected[$arMode]: ARMode = ARMode.NONE;
    protected[$preload] = false;

    private[$onARButtonContainerClick] = (event: Event) => {
      event.preventDefault();
      this.activateAR();
    };

    private[$onARStatus] = ({status}: {status: ARStatus}) => {
      if (status === ARStatus.NOT_PRESENTING ||
          this[$renderer].arRenderer.presentedScene === this[$scene]) {
        this.setAttribute('ar-status', status);
        this.dispatchEvent(
            new CustomEvent<ARStatusDetails>('ar-status', {detail: {status}}));
        if (status === ARStatus.NOT_PRESENTING) {
          this.removeAttribute('ar-tracking');
        } else if (status === ARStatus.SESSION_STARTED) {
          this.setAttribute('ar-tracking', ARTracking.TRACKING);
        }
      }
    };

    private[$onARTracking] = ({status}: {status: ARTracking}) => {
      this.setAttribute('ar-tracking', status);
      this.dispatchEvent(new CustomEvent<ARTrackingDetails>(
          'ar-tracking', {detail: {status}}));
    };

    private[$onARTap] = (event: Event) => {
      if ((event as any).data == '_apple_ar_quicklook_button_tapped') {
        this.dispatchEvent(new CustomEvent('quick-look-button-tapped'));
      }
    };

    connectedCallback() {
      super.connectedCallback();

      this[$renderer].arRenderer.addEventListener('status', this[$onARStatus]);
      this.setAttribute('ar-status', ARStatus.NOT_PRESENTING);

      this[$renderer].arRenderer.addEventListener(
          'tracking', this[$onARTracking]);

      this[$arAnchor].addEventListener('message', this[$onARTap]);
    }

    disconnectedCallback() {
      super.disconnectedCallback();

      this[$renderer].arRenderer.removeEventListener(
          'status', this[$onARStatus]);
      this[$renderer].arRenderer.removeEventListener(
          'tracking', this[$onARTracking]);

      this[$arAnchor].removeEventListener('message', this[$onARTap]);
    }

    update(changedProperties: Map<string, any>) {
      super.update(changedProperties);

      if (changedProperties.has('arScale')) {
        this[$scene].canScale = this.arScale !== 'fixed';
      }

      if (changedProperties.has('arPlacement')) {
        this[$scene].updateShadow();
        this[$needsRender]();
      }

      if (changedProperties.has('arModes')) {
        this[$arModes] = deserializeARModes(this.arModes);
      }

      if (changedProperties.has('ar') || changedProperties.has('arModes') ||
          changedProperties.has('src') || changedProperties.has('iosSrc')) {
        this[$selectARMode]();
      }
    }

    /**
     * Activates AR. Note that for any mode that is not WebXR-based, this
     * method most likely has to be called synchronous from a user
     * interaction handler. Otherwise, attempts to activate modes that
     * require user interaction will most likely be ignored.
     */
    async activateAR() {
      // console.log(this[$scene]);
      switch (this[$arMode]) {
        case ARMode.QUICK_LOOK:
          await this[$openIOSARQuickLook]();
          break;
        case ARMode.WEBXR:
          this._temp_src = this.src
          // if (this._zarboAndroidSrc && this.src !== this._zarboAndroidSrc) {
          //   this.src = this._zarboAndroidSrc
          //   await this[$updateSource]()
          //   await waitForEvent(this, 'load');
          //   // zzzz
          // }
          await this[$enterARWithWebXR]();
          break;
        case ARMode.SCENE_VIEWER:
          this[$openSceneViewer]();
          break;
        default:
          console.warn(
              'No AR Mode can be activated. This is probably due to missing \
configuration or device capabilities');
          break;
      }
    }

    getFileExtension(url: any) {
      return url.split('.').pop();
    }

    async[$selectARMode]() {
      let arMode = ARMode.NONE;
      if (this.ar) {
        if (this.src != null) {
          for (const value of this[$arModes]) {
            if (value === 'webxr' && IS_WEBXR_AR_CANDIDATE && !isWebXRBlocked &&
                await this[$renderer].arRenderer.supportsPresentation()) {
              arMode = ARMode.WEBXR;
              break;
            }
            if (value === 'scene-viewer' && IS_SCENEVIEWER_CANDIDATE &&
                !isSceneViewerBlocked) {
              arMode = ARMode.SCENE_VIEWER;
              break;
            }
            if (value === 'quick-look' && IS_AR_QUICKLOOK_CANDIDATE) {
              arMode = ARMode.QUICK_LOOK;
              break;
            }
          }
        }

        // The presence of ios-src overrides the absence of quick-look
        // ar-mode.
        if (arMode === ARMode.NONE && this._zarboIosSrc != null &&
            IS_AR_QUICKLOOK_CANDIDATE) {
          arMode = ARMode.QUICK_LOOK;
        }
      }

      if (arMode !== ARMode.NONE) {
        this[$arButtonContainer].classList.add('enabled');
        this[$arButtonContainer].addEventListener(
            'click', this[$onARButtonContainerClick]);
      } else if (this[$arButtonContainer].classList.contains('enabled')) {
        this[$arButtonContainer].removeEventListener(
            'click', this[$onARButtonContainerClick]);
        this[$arButtonContainer].classList.remove('enabled');

        // If AR went from working to not, notify the element.
        const status = ARStatus.FAILED;
        this.setAttribute('ar-status', status);
        this.dispatchEvent(
            new CustomEvent<ARStatusDetails>('ar-status', {detail: {status}}));
      }
      this[$arMode] = arMode;
    }

    protected async[$enterARWithWebXR]() {
      console.log('Attempting to present in AR with WebXR...');

      if (this._zarboAndroidSrc && this.src !== this._zarboAndroidSrc) {
        this.src = this._zarboAndroidSrc
      } 

      await this[$triggerLoad]();

      try {
        console.log(this[$scene])
        this[$arButtonContainer].removeEventListener(
            'click', this[$onARButtonContainerClick]);
        const {arRenderer} = this[$renderer];
        arRenderer.placeOnWall = this.arPlacement === 'wall';
        await arRenderer.present(this[$scene], this.xrEnvironment);
        // waitForEvent(this[$renderer].arRenderer, 'end').then(async () => {
        //   alert('я работаю')
        //   this.src = this._temp_src
        //   await this[$updateSource]()
        //   await waitForEvent(this, 'load');
        // }) // zzzz
        // this[$renderer].arRenderer.addEventListener('status', async res => {
        //   // alert('я работаю')
        //   if (res.status === 'session-end') { // мой кастомный эвенет
        //     this.src = this._temp_src
        //     await this[$updateSource]()
        //     // await waitForEvent(this, 'load');
        //   }
        // });
      } catch (error) {
        console.warn('Error while trying to present in AR with WebXR');
        console.error(error);
        await this[$renderer].arRenderer.stopPresenting();
        isWebXRBlocked = true;
        console.warn('Falling back to next ar-mode');
        await this[$selectARMode]();
        this.activateAR();
      } finally {
        // this.src = this._temp_src;
        this[$selectARMode]();
        // console.log("LOOOOGGGG:", this.src, this._zarboAndroidSrc);
      }
    }

    async[$triggerLoad]() {
      if (!this.loaded) {
        this[$preload] = true;
        this[$updateSource]();
        await waitForEvent(this, 'load');
        this[$preload] = false;
      }
    }

    [$shouldAttemptPreload](): boolean {
      return super[$shouldAttemptPreload]() || this[$preload];
    }

    /**
     * Takes a URL and a title string, and attempts to launch Scene Viewer on
     * the current device.
     */
    [$openSceneViewer]() {
      const location = self.location.toString();
      const locationUrl = new URL(location);
      // const modelUrl = new URL(this.src!, location);
      // let currentModel = '' 
      // if (this._zarboAndroidSrc) {
      //   currentModel = this._zarboAndroidSrc
      // } else {
      //   currentModel = this.src!
      // }

      const modelUrl = new URL(this.src!, location);
      if (modelUrl.hash)
        modelUrl.hash = '';
      const params = new URLSearchParams(modelUrl.search);

      locationUrl.hash = noArViewerSigil;

      // modelUrl can contain title/link/sound etc.
      params.set('mode', 'ar_preferred');
      if (!params.has('disable_occlusion')) {
        params.set('disable_occlusion', 'true');
      }
      if (this.arScale === 'fixed') {
        params.set('resizable', 'false');
      }
      if (this.arPlacement === 'wall') {
        params.set('enable_vertical_placement', 'true');
      }
      if (params.has('sound')) {
        const soundUrl = new URL(params.get('sound')!, location);
        params.set('sound', soundUrl.toString());
      }
      if (params.has('link')) {
        const linkUrl = new URL(params.get('link')!, location);
        params.set('link', linkUrl.toString());
      }

      const intent = `intent://arvr.google.com/scene-viewer/1.0?${
          params.toString() + '&file=' +
          encodeURIComponent(
              modelUrl
                  .toString())}#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;S.browser_fallback_url=${
          encodeURIComponent(locationUrl.toString())};end;`;

      const undoHashChange = () => {
        if (self.location.hash === noArViewerSigil) {
          isSceneViewerBlocked = true;
          // The new history will be the current URL with a new hash.
          // Go back one step so that we reset to the expected URL.
          // NOTE(cdata): this should not invoke any browser-level navigation
          // because hash-only changes modify the URL in-place without
          // navigating:
          self.history.back();
          console.warn('Error while trying to present in AR with Scene Viewer');
          console.warn('Falling back to next ar-mode');
          this[$selectARMode]();
          // Would be nice to activateAR() here, but webXR fails due to not
          // seeing a user activation.
        }
      };

      self.addEventListener('hashchange', undoHashChange, {once: true});

      this[$arAnchor].setAttribute('href', intent);
      console.log('Attempting to present in AR with Scene Viewer...');
      this[$arAnchor].click();
    }

    /**
     * Takes a URL to a USDZ file and sets the appropriate fields so that
     * Safari iOS can intent to their AR Quick Look.
     */
    async[$openIOSARQuickLook]() {
      const generateUsdz = !this.iosSrc;
      // const isZarboIosrSrcUsdz = this._zarboIosSrc && (this._zarboIosSrc.split('.').splice(-1, 1)[0] === 'usdz')
      // if (!isZarboIosrSrcUsdz) {
      //   this.src = this._zarboIosSrc
      //   await this[$updateSource]()
      //   // await waitForEvent(this, 'load');
      // }

      // const generateUsdz = !this.iosSrc
      // if (generateUsdz && this._zarboIosSrc) {
      //   this.src = this._zarboIosSrc
      // }
      // const generateUsdz = !isZarboIosrSrcUsdz || !this.iosSrc;
      // const generateUsdz = !isZarboIosrSrcUsdz;
      // if (this.iosSrc) { // если есть, то точно usdz
      //   generateUsdz = false
      // } else if (this._zarboIosSrc) { // если есть, не факт что usdz
      //   let format = this._zarboIosSrc.split('.').splice(-1, 1)[0]
      //   if (format === 'usdz') {
      //     generateUsdz = false
      //   }
      // }
      // const demostrateIosUrl = !generateUsdz ? (this._zarboIosSrc || this.iosSrc) : null

      this[$arButtonContainer].classList.remove('enabled');

      const objectURL = generateUsdz ? await this.prepareUSDZ() : this.iosSrc!;
      // const objectURL = generateUsdz ? await this.prepareUSDZ() : this._zarboIosSrc!;
      const modelUrl = new URL(objectURL, self.location.toString());

      if (generateUsdz) {
        const location = self.location.toString();
        const locationUrl = new URL(location);
        const srcUrl = new URL(this._zarboIosSrc!, locationUrl);
        // const srcUrl = new URL(this.src!, locationUrl);
        if (srcUrl.hash) {
          modelUrl.hash = srcUrl.hash;
        }
      }

      if (this.arScale === 'fixed') {
        if (modelUrl.hash) {
          modelUrl.hash += '&';
        }
        modelUrl.hash += 'allowsContentScaling=0';
      }

      const anchor = this[$arAnchor];
      anchor.setAttribute('rel', 'ar');
      const img = document.createElement('img');
      anchor.appendChild(img);
      anchor.setAttribute('href', modelUrl.toString());
      if (generateUsdz) {
        anchor.setAttribute('download', 'model.usdz');
      }

      // attach anchor to shadow DOM to ensure iOS16 ARQL banner click message
      // event propagation
      anchor.style.display = 'none';
      if (!anchor.isConnected)
        this.shadowRoot!.appendChild(anchor);

      console.log('Attempting to present in AR with Quick Look...');
      anchor.click();
      anchor.removeChild(img);
      if (generateUsdz) {
        URL.revokeObjectURL(objectURL);
      }
      this[$arButtonContainer].classList.add('enabled');
    }

    // modelLoader(url: any): Promise<Object3D> {
    //   let gltfLoader = new GLTFLoader()

    //   return new Promise((resolve) => {
    //     // @ts-ignore
    //     gltfLoader.load(url, data => resolve(data));
    //   });
    // }
 
    async prepareUSDZ(): Promise<string> {
      const updateSourceProgress = this[$progressTracker].beginActivity();

      await this[$triggerLoad]();

      const {model, shadow} = this[$scene];
      
      // if (this._zarboIosSrc) {
      //   model = await this.modelLoader(this._zarboIosSrc)
      // }

      if (model == null) {
        return '';
      }

      let visible = false;

      // Remove shadow from export
      if (shadow != null) {
        visible = shadow.visible;
        shadow.visible = false;
      }

      updateSourceProgress(0.2);

      const exporter = new USDZExporter();
      const arraybuffer = await exporter.parse(model);

      const blob = new Blob([arraybuffer], {
        type: 'model/vnd.usdz+zip',
      });

      const url = URL.createObjectURL(blob);

      updateSourceProgress(1);

      if (shadow != null) {
        shadow.visible = visible;
      }

      return url;
    }
  }

  return ARModelViewerElement;
};