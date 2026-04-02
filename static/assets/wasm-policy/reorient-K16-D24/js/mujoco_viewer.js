/**
 * MuJoCo WASM + Three.js viewer.
 *
 * Loads a MuJoCo XML scene via WebAssembly and renders it with Three.js.
 * Provides physics stepping, camera controls, and click-drag perturbation.
 *
 * Usage:
 *   const viewer = new MuJoCoViewer(container, {
 *     sceneXML: "scene.xml",
 *     wasmURL: "dist/mujoco_wasm.js",
 *     onReady: () => console.log("ready"),
 *   });
 *   await viewer.init();
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildBodies, syncBodies } from "./mujoco_utils.js";

// Three.js Y-up → MuJoCo Z-up coordinate conversion.
function _toMujocoPos(v) {
  return v.set(v.x, -v.z, v.y);
}

// MuJoCo Z-up → Three.js Y-up coordinate conversion.
function _fromMujocoPos(v) {
  return v.set(v.x, v.z, -v.y);
}

export class MuJoCoViewer {
  /**
   * @param {HTMLElement} container - DOM element to mount the viewer in.
   * @param {object} options
   * @param {string} options.sceneXML - Path to MuJoCo XML scene file.
   * @param {string} [options.wasmURL] - Path to mujoco_wasm.js module.
   * @param {string} [options.background="#f0f2f5"] - Background color.
   * @param {number[]|null} [options.cameraPos] - Initial camera [x, y, z].
   * @param {number[]|null} [options.cameraTarget] - Camera target [x, y, z].
   * @param {function} [options.onStatus] - Status message callback.
   * @param {function} [options.onReady] - Called when initialization completes.
   */
  constructor(container, options = {}) {
    this.container = container;
    this.sceneXML = options.sceneXML || "";
    this.wasmURL = options.wasmURL || "dist/mujoco_wasm.js";
    this.bgColor = options.background || "#f0f2f5";
    this.cameraPos = options.cameraPos || null;
    this.cameraTarget = options.cameraTarget || null;
    this.onStatus = options.onStatus || (() => {});
    this.onReady = options.onReady || (() => {});

    // MuJoCo state.
    this.mujoco = null;
    this.model = null;
    this.data = null;

    // Three.js state.
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.bodies = null;
    this.meshes = []; // Flat list of body meshes for raycasting.

    // Animation.
    this._animFrameId = null;
    this._autoStep = false;
    this._cameraTracking = false;

    // Drag interaction state.
    this._dragging = false;
    this._dragBodyId = -1;
    this._dragPointLocal = new THREE.Vector3();
    this._dragPointWorld = new THREE.Vector3();
    this._dragCursorWorld = new THREE.Vector3();
    this._dragPlane = new THREE.Plane();
    this._dragArrow = null;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
  }

  /** Initialize WASM, load model, build Three.js scene. */
  async init() {
    this.onStatus("Loading MuJoCo WASM...");
    this.mujoco = await this._loadWasm();

    this.onStatus("Loading scene...");
    await this._loadScene();

    this.onStatus("Building 3D scene...");
    this._setupThreeScene();
    this._buildMeshes();
    this._setupControls();
    this._setupDragInteraction();

    // Apply keyframe (sets proper initial pose + height) then forward pass.
    if (this.model.nkey > 0) {
      this.mujoco.mj_resetDataKeyframe(this.model, this.data, 0);
    }
    this.mujoco.mj_forward(this.model, this.data);
    this._updateTransforms();

    this.onReady();
    this._startRenderLoop();
  }

  /** Reset simulation data to initial keyframe. */
  resetData() {
    if (!this.model || !this.data) return;
    this.mujoco.mj_resetData(this.model, this.data);
    if (this.model.nkey > 0) {
      this.mujoco.mj_resetDataKeyframe(this.model, this.data, 0);
    }
    this.mujoco.mj_forward(this.model, this.data);
    this._cancelDrag();
  }

  /** Step simulation n times. */
  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.mujoco.mj_step(this.model, this.data);
    }
  }

  /** Single render frame (update transforms + draw). */
  render() {
    this._updateCameraTracking();
    this._updateTransforms();
    this._updateDragArrow();
    this.renderer.render(this.scene, this.camera);
  }

  /** Get the MuJoCo model. */
  getModel() {
    return this.model;
  }

  /** Get the MuJoCo data. */
  getData() {
    return this.data;
  }

  /** Get the MuJoCo WASM module. */
  getMujoco() {
    return this.mujoco;
  }

  /** Enable/disable automatic physics stepping in render loop. */
  setAutoStep(enabled) {
    this._autoStep = enabled;
  }

  /** Get the Three.js scene. */
  getScene() {
    return this.scene;
  }

  /** Enable camera tracking (follows robot root body). */
  enableCameraTracking() {
    this._cameraTracking = true;
  }

  /** Disable camera tracking. */
  disableCameraTracking() {
    this._cameraTracking = false;
  }

  /** Stop the viewer's own render loop. */
  stopRenderLoop() {
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
  }

  /** Restart the viewer's render loop. */
  startRenderLoop() {
    this._startRenderLoop();
  }

  /** Whether a drag interaction is active. */
  isDragging() {
    return this._dragging;
  }

  /** Set body IDs that should not be draggable. */
  setNoDragBodies(bodyIdSet) {
    this._noDragBodyIds = bodyIdSet;
  }

  /**
   * Apply drag forces to qfrc_applied. Call before each physics step batch.
   * Clears qfrc_applied, then applies the drag spring force if active.
   */
  updateDragForces() {
    const data = this.data;
    if (!data) return;

    // Clear external forces.
    for (let i = 0; i < data.qfrc_applied.length; i++) {
      data.qfrc_applied[i] = 0;
    }

    if (!this._dragging) return;

    // Recompute world-space anchor from body's current pose.
    this._updateDragAnchor();

    // Spring-damper force: F = kp * displacement - kd * velocity.
    const disp = this._dragCursorWorld.clone().sub(this._dragPointWorld);
    const len = disp.length();
    if (len < 0.001) return;

    const bid = this._dragBodyId;
    const mass = this.model.body_mass[bid];
    const kp = mass * 250;
    const kd = mass * 50; // Damping to prevent oscillation.

    // Body linear velocity (cvel stores [angular(3), linear(3)]).
    const cvelOff = bid * 6;
    const bodyVel = new THREE.Vector3(
      this.data.cvel[cvelOff + 3],
      this.data.cvel[cvelOff + 4],
      this.data.cvel[cvelOff + 5],
    );
    // cvel is in MuJoCo coords; convert to Three.js for subtraction.
    const bodyVelTJS = _fromMujocoPos(bodyVel);

    const force = disp.multiplyScalar(kp).sub(bodyVelTJS.multiplyScalar(kd));
    const forceVec = _toMujocoPos(force);
    const pointVec = _toMujocoPos(this._dragPointWorld.clone());

    this.mujoco.mj_applyFT(
      this.model,
      this.data,
      new Float64Array([forceVec.x, forceVec.y, forceVec.z]),
      new Float64Array([0, 0, 0]),
      new Float64Array([pointVec.x, pointVec.y, pointVec.z]),
      bid,
      this.data.qfrc_applied,
    );
  }

  // ── Private methods ──────────────────────────────────

  async _loadWasm() {
    const absoluteURL = new URL(this.wasmURL, window.location.href).href;
    const module = await import(absoluteURL);
    const factory = module.default;
    const mujoco = await factory();
    mujoco.FS.mkdir("/working");
    mujoco.FS.mount(mujoco.MEMFS, { root: "." }, "/working");
    return mujoco;
  }

  async _loadScene() {
    const xmlResponse = await fetch(this.sceneXML);
    if (!xmlResponse.ok) {
      throw new Error(`Failed to fetch scene XML: ${this.sceneXML}`);
    }
    const xmlText = await xmlResponse.text();

    const { meshFiles, textureFiles } = this._parseAssetFiles(xmlText);

    const baseURL = this.sceneXML.substring(
      0,
      this.sceneXML.lastIndexOf("/") + 1,
    );

    // MuJoCo resolves mesh paths with meshdir, texture paths with
    // texturedir.  Each defaults to "" (relative to the XML file).
    let meshDir = "";
    const meshDirMatch = xmlText.match(/meshdir\s*=\s*"([^"]+)"/);
    if (meshDirMatch) {
      meshDir = meshDirMatch[1];
      if (!meshDir.endsWith("/")) meshDir += "/";
    }

    let textureDir = "";
    const texDirMatch = xmlText.match(/texturedir\s*=\s*"([^"]+)"/);
    if (texDirMatch) {
      textureDir = texDirMatch[1];
      if (!textureDir.endsWith("/")) textureDir += "/";
    }

    // Helper: fetch a list of files and write them into the WASM VFS.
    const loadFiles = async (files, dirPrefix) => {
      const vfsDir = "/working/" + dirPrefix;
      this._ensureDir(vfsDir);
      await Promise.all(
        files.map(async (filename) => {
          const url = baseURL + dirPrefix + filename;
          const response = await fetch(url);
          if (!response.ok) {
            console.warn(`Failed to fetch asset: ${url}`);
            return;
          }
          const buffer = await response.arrayBuffer();
          const fullPath = vfsDir + filename;
          const lastSlash = fullPath.lastIndexOf("/");
          if (lastSlash > 0) {
            this._ensureDir(fullPath.substring(0, lastSlash));
          }
          this.mujoco.FS.writeFile(fullPath, new Uint8Array(buffer));
        }),
      );
    };

    const totalFiles = meshFiles.length + textureFiles.length;
    this.onStatus(`Loading ${totalFiles} asset files...`);
    await Promise.all([
      loadFiles(meshFiles, meshDir),
      loadFiles(textureFiles, textureDir),
    ]);

    this.mujoco.FS.writeFile("/working/scene.xml", xmlText);
    this.model = this.mujoco.MjModel.loadFromXML("/working/scene.xml");
    this.data = new this.mujoco.MjData(this.model);
  }

  _ensureDir(path) {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur += "/" + p;
      try {
        this.mujoco.FS.mkdir(cur);
      } catch {
        // Already exists.
      }
    }
  }

  _parseAssetFiles(xmlText) {
    const meshFiles = [];
    const textureFiles = [];
    const meshRegex = /<mesh\b[^>]*\bfile\s*=\s*"([^"]+)"/g;
    // Match file="...", fileright="...", fileleft="...", etc. on
    // <texture> elements (cube maps use per-face file attributes).
    const texRegex =
      /<texture\b([^>]*)>/g;
    const fileAttrRegex = /\bfile\w*\s*=\s*"([^"]+)"/g;
    let match;
    while ((match = meshRegex.exec(xmlText)) !== null) {
      meshFiles.push(match[1]);
    }
    while ((match = texRegex.exec(xmlText)) !== null) {
      const attrs = match[1];
      let fmatch;
      while ((fmatch = fileAttrRegex.exec(attrs)) !== null) {
        textureFiles.push(fmatch[1]);
      }
    }
    return {
      meshFiles: [...new Set(meshFiles)],
      textureFiles: [...new Set(textureFiles)],
    };
  }

  _setupThreeScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.bgColor);

    const aspect =
      this.container.clientWidth / this.container.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 100);

    if (this.cameraPos) {
      this.camera.position.set(
        this.cameraPos[0],
        this.cameraPos[2],
        -this.cameraPos[1],
      );
    } else {
      this.camera.position.set(2, 1.5, 3);
    }

    if (this.cameraTarget) {
      this.camera.lookAt(
        this.cameraTarget[0],
        this.cameraTarget[2],
        -this.cameraTarget[1],
      );
    } else {
      this.camera.lookAt(0, 0.5, 0);
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight,
    );
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    this.scene.add(dirLight);

    // Shadow-only ground (transparent, only renders shadows).
    const groundGeom = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.15 });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Infinite-looking grid.
    const grid = new THREE.GridHelper(200, 200, 0xbbbbbb, 0xdddddd);
    grid.position.y = 0.001;
    this.scene.add(grid);

    // Fog fades distant grid lines for an infinite feel.
    this.scene.fog = new THREE.Fog(this.bgColor, 15, 50);

    // Force arrow (cylinder shaft + cone head).
    const arrowMat = new THREE.MeshPhongMaterial({
      color: 0xff4444,
      transparent: true,
      opacity: 0.85,
    });
    const shaftGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 8);
    shaftGeo.translate(0, 0.5, 0);
    const shaft = new THREE.Mesh(shaftGeo, arrowMat);
    shaft.name = "shaft";

    const headGeo = new THREE.ConeGeometry(0.022, 0.06, 8);
    headGeo.translate(0, 0.03, 0);
    const head = new THREE.Mesh(headGeo, arrowMat.clone());
    head.name = "head";

    this._dragArrow = new THREE.Group();
    this._dragArrow.add(shaft);
    this._dragArrow.add(head);
    this._dragArrow.visible = false;
    this.scene.add(this._dragArrow);

    this._resizeObserver = new ResizeObserver(() => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this._resizeObserver.observe(this.container);
  }

  _setupControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    if (this.cameraTarget) {
      this.controls.target.set(
        this.cameraTarget[0],
        this.cameraTarget[2],
        -this.cameraTarget[1],
      );
    } else {
      this.controls.target.set(0, 0.5, 0);
    }
    this.controls.update();
  }

  _buildMeshes() {
    const result = buildBodies(this.model);
    this.bodies = result.bodies;
    this.meshes = result.meshes;
    this.scene.add(result.root);
  }

  _updateTransforms() {
    if (this.bodies) {
      syncBodies(this.model, this.data, this.bodies);
    }
  }

  _updateCameraTracking() {
    if (!this._cameraTracking || !this.data) return;
    const rx = this.data.qpos[0];
    const rz = -this.data.qpos[1];

    const alpha = 0.05;
    const dx = (rx - this.controls.target.x) * alpha;
    const dz = (rz - this.controls.target.z) * alpha;

    this.controls.target.x += dx;
    this.controls.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
  }

  // ── Drag interaction ────────────────────────────────

  _setupDragInteraction() {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    el.addEventListener("pointermove", (e) => this._onPointerMove(e));
    el.addEventListener("pointerup", (e) => this._onPointerUp(e));
    el.addEventListener("pointercancel", (e) => this._onPointerUp(e));
    window.addEventListener("blur", () => this._cancelDrag());
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObjects(this.meshes, false);

    for (const hit of hits) {
      const bid = hit.object.bodyID;
      // Skip world body (0), fixed base (1), and excluded bodies.
      if (bid !== undefined && bid > 1 && !this._noDragBodyIds?.has(bid)) {
        this._dragging = true;
        this._dragBodyId = bid;

        // Store hit point in body-local frame.
        this._dragPointWorld.copy(hit.point);
        this._dragCursorWorld.copy(hit.point);
        const bodyGroup = this.bodies[bid];
        this._dragPointLocal.copy(hit.point);
        bodyGroup.worldToLocal(this._dragPointLocal);

        // Set up drag plane facing the camera.
        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);
        this._dragPlane.setFromNormalAndCoplanarPoint(camDir, hit.point);

        this.controls.enabled = false;

        if (e.pointerId !== undefined) {
          this.renderer.domElement.setPointerCapture(e.pointerId);
        }
        return;
      }
    }
  }

  _onPointerMove(e) {
    if (!this._dragging) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Recompute anchor world position from body's current transform.
    this._updateDragAnchor();

    // Update drag plane to follow the body.
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    this._dragPlane.setFromNormalAndCoplanarPoint(
      camDir,
      this._dragPointWorld,
    );

    // Project cursor onto drag plane.
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const target = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(this._dragPlane, target)) return;
    this._dragCursorWorld.copy(target);
  }

  _onPointerUp(e) {
    if (!this._dragging) return;
    this._dragging = false;
    this._dragBodyId = -1;
    this._dragArrow.visible = false;

    // Clear external forces.
    if (this.data) {
      for (let i = 0; i < this.data.qfrc_applied.length; i++) {
        this.data.qfrc_applied[i] = 0;
      }
    }

    if (e && e.pointerId !== undefined) {
      try {
        this.renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore.
      }
    }
    setTimeout(() => {
      this.controls.enabled = true;
    }, 0);
  }

  _cancelDrag() {
    if (!this._dragging) return;
    this._dragging = false;
    this._dragBodyId = -1;
    this._dragArrow.visible = false;
    this.controls.enabled = true;
    if (this.data) {
      for (let i = 0; i < this.data.qfrc_applied.length; i++) {
        this.data.qfrc_applied[i] = 0;
      }
    }
  }

  _updateDragAnchor() {
    if (!this._dragging) return;
    const bodyGroup = this.bodies[this._dragBodyId];
    this._dragPointWorld.copy(this._dragPointLocal);
    bodyGroup.localToWorld(this._dragPointWorld);
  }

  _updateDragArrow() {
    if (!this._dragging || !this._dragArrow) {
      if (this._dragArrow) this._dragArrow.visible = false;
      return;
    }

    const disp = this._dragCursorWorld.clone().sub(this._dragPointWorld);
    const len = disp.length();

    if (len < 0.001) {
      this._dragArrow.visible = false;
      return;
    }

    const arrowLen = Math.min(len, 0.5);
    const dir = disp.clone().normalize();

    this._dragArrow.position.copy(this._dragPointWorld);

    const quat = new THREE.Quaternion();
    quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this._dragArrow.quaternion.copy(quat);

    const shaft = this._dragArrow.getObjectByName("shaft");
    const head = this._dragArrow.getObjectByName("head");
    const headLen = Math.min(arrowLen * 0.35, 0.06);
    const shaftLen = arrowLen - headLen;
    shaft.scale.set(1, Math.max(shaftLen, 0.001), 1);
    head.position.set(0, shaftLen, 0);
    head.scale.set(1, 1, 1);

    this._dragArrow.visible = true;
  }

  _startRenderLoop() {
    const animate = () => {
      this._animFrameId = requestAnimationFrame(animate);
      if (this._autoStep) {
        this.step(1);
      }
      this.controls.update();
      this.render();
    };
    animate();
  }
}
