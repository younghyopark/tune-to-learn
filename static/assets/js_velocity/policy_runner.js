/**
 * ONNX policy inference runner for MuJoCo WASM.
 *
 * Constructs observations from MuJoCo state, runs ONNX inference,
 * and applies actions back to the simulation at 50Hz (configurable).
 *
 * Usage:
 *   const runner = new PolicyRunner(viewer, config);
 *   await runner.init("policy.onnx");
 *   runner.initArrows();
 *   runner.start();
 *   runner.setCommand([0.5, 0, 0]); // Walk forward
 */

import * as THREE from "three";
import { rotateVectorByQuatInverse } from "./mujoco_utils.js";

// Arrow colors matching Viser viewer (hex approximations of RGBA).
const ARROW_COLORS = {
  cmdLin: 0x3344aa, // Command linear velocity (blue)
  cmdAng: 0x33aa33, // Command angular velocity (green)
  actLin: 0x00aaff, // Actual linear velocity (cyan)
  actAng: 0x00ff66, // Actual angular velocity (light green)
};

function _createArrowMesh(color, opacity) {
  const group = new THREE.Group();
  const mat = new THREE.MeshPhongMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });

  // Shaft: unit cylinder along +Y, base at origin.
  const shaftGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
  shaftGeom.translate(0, 0.5, 0);
  const shaft = new THREE.Mesh(shaftGeom, mat);

  // Head: unit cone along +Y, base at origin.
  const headGeom = new THREE.ConeGeometry(1, 1, 8);
  headGeom.translate(0, 0.5, 0);
  const head = new THREE.Mesh(headGeom, mat.clone());

  group.add(shaft);
  group.add(head);
  group.visible = false;
  group.userData = { shaft, head };
  return group;
}

const _UP = new THREE.Vector3(0, 1, 0);
const _tmpQuat = new THREE.Quaternion();

function _setArrow(arrow, origin, direction, length) {
  if (length < 0.005) {
    arrow.visible = false;
    return;
  }
  arrow.visible = true;

  const shaftRadius = 0.008;
  const headRadius = 0.02;
  const headRatio = 0.25;

  const shaftLen = length * (1 - headRatio);
  const headLen = length * headRatio;

  arrow.position.copy(origin);

  // Orient: default is +Y, rotate to direction.
  const dir = direction.clone().normalize();
  _tmpQuat.setFromUnitVectors(_UP, dir);
  arrow.quaternion.copy(_tmpQuat);

  const { shaft, head } = arrow.userData;
  shaft.scale.set(shaftRadius, shaftLen, shaftRadius);
  head.position.set(0, shaftLen, 0);
  head.scale.set(headRadius, headLen, headRadius);
}

// Rotate a vector by a quaternion (MuJoCo convention: w,x,y,z).
function _rotByQuat(q, v) {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

// MuJoCo (Z-up) → Three.js (Y-up).
function _toThree(mx, my, mz) {
  return new THREE.Vector3(mx, mz, -my);
}

export class PolicyRunner {
  /**
   * @param {import('./mujoco_viewer.js').MuJoCoViewer} viewer
   * @param {object} config - Policy configuration from policy_config.json.
   */
  constructor(viewer, config) {
    this.viewer = viewer;
    this.config = config;

    this.session = null;
    this.sensorAddrs = {};
    this.command = new Float32Array(3); // [vx, vy, omega_z]
    this.lastAction = new Float32Array(config.num_joints);
    this._obsBuffer = null; // pre-allocated in init()
    this.obsDim = config.observation_dims.reduce((a, b) => a + b, 0);
    this._obsBuffer = new Float32Array(this.obsDim);

    this._animFrameId = null;
    this._running = false;
    this._policyIntervalMs =
      config.timestep * config.decimation * 1000; // 20ms default
    this._arrows = null;
    this.onStep = null; // Optional callback(data, actionData).
  }

  /** Load the policy model and resolve sensor addresses.
   *  Tries to load lightweight JSON weights first (pure JS inference),
   *  falls back to ONNX runtime if JSON not available.
   */
  async init(onnxPath) {
    this._useJsInference = false;

    // Try loading JSON weights for pure JS inference (no ONNX WASM needed)
    const jsonPath = onnxPath.replace(/\.onnx$/, '_weights.json');
    try {
      const resp = await fetch(jsonPath);
      if (resp.ok) {
        const raw = await resp.json();
        this._jsWeights = {};
        for (const [name, val] of Object.entries(raw)) {
          const bytes = Uint8Array.from(atob(val.data_b64), c => c.charCodeAt(0));
          this._jsWeights[name] = {
            shape: val.shape,
            data: new Float32Array(bytes.buffer),
          };
        }
        this._useJsInference = true;
        console.log('PolicyRunner: using JS inference (no ONNX runtime)');
      }
    } catch (_) {}

    // Fall back to ONNX runtime
    if (!this._useJsInference) {
      const ort = await import("onnxruntime-web");
      this.session = await ort.InferenceSession.create(onnxPath, {
        executionProviders: ["wasm"],
      });
      this._ort = ort;
      console.log('PolicyRunner: using ONNX runtime');
    }

    this._resolveSensorAddresses();
  }

  /** Create velocity arrow visualizations in the Three.js scene. */
  initArrows() {
    const scene = this.viewer.getScene();
    if (!scene) return;

    this._arrows = {
      cmdLin: _createArrowMesh(ARROW_COLORS.cmdLin, 0.6),
      cmdAng: _createArrowMesh(ARROW_COLORS.cmdAng, 0.6),
      actLin: _createArrowMesh(ARROW_COLORS.actLin, 0.7),
      actAng: _createArrowMesh(ARROW_COLORS.actAng, 0.7),
    };
    for (const arrow of Object.values(this._arrows)) {
      scene.add(arrow);
    }
  }

  /** Start the policy inference + simulation loop. */
  start() {
    if (this._running) return;
    this._running = true;

    // Take over rendering — stop the viewer's own rAF loop.
    this.viewer.stopRenderLoop();

    const model = this.viewer.getModel();
    const data = this.viewer.getData();
    const mujoco = this.viewer.getMujoco();

    let busy = false;

    const animate = async () => {
      if (!this._running) return;
      this._animFrameId = requestAnimationFrame(animate);

      if (busy) return;
      busy = true;

      const obs = this.buildObservation();
      const action = await this._runInference(obs);
      this._applyAction(action, data);
      if (this.onStep) this.onStep(data, action);

      this.viewer.updateDragForces();

      for (let i = 0; i < this.config.decimation; i++) {
        mujoco.mj_step(model, data);
      }

      this._updateArrows();
      this.viewer.controls.update();
      this.viewer.render();
      busy = false;
    };

    requestAnimationFrame(animate);
  }

  /** Stop the inference loop. */
  stop() {
    this._running = false;
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    // Hand rendering back to the viewer's own loop.
    this.viewer.startRenderLoop();
  }

  /** Set velocity command [lin_vel_x, lin_vel_y, ang_vel_z]. */
  setCommand(cmd) {
    this.command[0] = cmd[0] || 0;
    this.command[1] = cmd[1] || 0;
    this.command[2] = cmd[2] || 0;
  }

  /** Reset simulation and last action. */
  reset() {
    this.viewer.resetData();
    this.lastAction.fill(0);
    this.command.fill(0);
  }

  /**
   * Build the observation vector from MuJoCo state.
   * Matches the Python observation pipeline exactly.
   * @returns {Float32Array}
   */
  buildObservation() {
    const data = this.viewer.getData();
    const cfg = this.config;
    const obs = this._obsBuffer;
    obs.fill(0);
    let offset = 0;

    for (const term of cfg.observation_order) {
      switch (term) {
        case "base_lin_vel": {
          const addr = this.sensorAddrs.velocimeter;
          obs[offset + 0] = data.sensordata[addr + 0];
          obs[offset + 1] = data.sensordata[addr + 1];
          obs[offset + 2] = data.sensordata[addr + 2];
          offset += 3;
          break;
        }

        case "base_ang_vel": {
          const addr = this.sensorAddrs.gyro;
          obs[offset + 0] = data.sensordata[addr + 0];
          obs[offset + 1] = data.sensordata[addr + 1];
          obs[offset + 2] = data.sensordata[addr + 2];
          offset += 3;
          break;
        }

        case "projected_gravity": {
          const q = [
            data.qpos[3],
            data.qpos[4],
            data.qpos[5],
            data.qpos[6],
          ];
          const pg = rotateVectorByQuatInverse([0, 0, -1], q);
          obs[offset + 0] = pg[0];
          obs[offset + 1] = pg[1];
          obs[offset + 2] = pg[2];
          offset += 3;
          break;
        }

        case "joint_pos": {
          const qOff = cfg.qpos_joint_offset;
          for (let i = 0; i < cfg.num_joints; i++) {
            obs[offset + i] =
              data.qpos[qOff + i] - cfg.default_joint_pos[i];
          }
          offset += cfg.num_joints;
          break;
        }

        case "joint_vel": {
          const vOff = cfg.qvel_joint_offset;
          for (let i = 0; i < cfg.num_joints; i++) {
            obs[offset + i] = data.qvel[vOff + i];
          }
          offset += cfg.num_joints;
          break;
        }

        case "actions": {
          for (let i = 0; i < cfg.num_joints; i++) {
            obs[offset + i] = this.lastAction[i];
          }
          offset += cfg.num_joints;
          break;
        }

        case "command": {
          obs[offset + 0] = this.command[0];
          obs[offset + 1] = this.command[1];
          obs[offset + 2] = this.command[2];
          offset += 3;
          break;
        }

        case "height_scan": {
          offset += 16;
          break;
        }

        default:
          console.warn(`Unknown observation term: ${term}`);
          break;
      }
    }

    return obs;
  }

  // ── Private methods ──────────────────────────────────

  async _runInference(observation) {
    if (!this._outputBuffer) {
      this._outputBuffer = new Float32Array(this.config.num_joints);
    }

    if (this._useJsInference) {
      return this._runJsInference(observation);
    }

    // ONNX runtime path
    if (!this._inputTensor) {
      this._inputTensor = new this._ort.Tensor(
        "float32",
        new Float32Array(this.obsDim),
        [1, this.obsDim],
      );
    }
    this._inputTensor.data.set(observation);
    const feeds = { [this.config.onnx_input_name]: this._inputTensor };
    const results = await this.session.run(feeds);
    const outputTensor = results[this.config.onnx_output_name];
    this._outputBuffer.set(outputTensor.data);
    for (const key in results) {
      try { results[key].dispose(); } catch(_) {}
    }
    return this._outputBuffer;
  }

  /** Pure JS forward pass — no WASM, no allocations per step. */
  _runJsInference(observation) {
    const w = this._jsWeights;
    const mean = w['obs_normalizer._mean'].data;
    const std = w['onnx::Div_24'].data;

    // Normalize: (obs - mean) / std
    if (!this._jsBuffers) {
      this._jsBuffers = {
        l0: new Float32Array(512),
        l1: new Float32Array(256),
        l2: new Float32Array(128),
      };
    }
    const buf = this._jsBuffers;

    // Layer 0: Linear(99 → 512) + ELU
    const w0 = w['mlp.0.weight'].data;  // [512, 99] row-major
    const b0 = w['mlp.0.bias'].data;    // [512]
    for (let i = 0; i < 512; i++) {
      let sum = b0[i];
      const row = i * 99;
      for (let j = 0; j < 99; j++) {
        sum += w0[row + j] * ((observation[j] - mean[j]) / std[j]);
      }
      buf.l0[i] = sum > 0 ? sum : Math.expm1(sum); // ELU
    }

    // Layer 1: Linear(512 → 256) + ELU
    const w1 = w['mlp.2.weight'].data;  // [256, 512]
    const b1 = w['mlp.2.bias'].data;    // [256]
    for (let i = 0; i < 256; i++) {
      let sum = b1[i];
      const row = i * 512;
      for (let j = 0; j < 512; j++) {
        sum += w1[row + j] * buf.l0[j];
      }
      buf.l1[i] = sum > 0 ? sum : Math.expm1(sum);
    }

    // Layer 2: Linear(256 → 128) + ELU
    const w2 = w['mlp.4.weight'].data;  // [128, 256]
    const b2 = w['mlp.4.bias'].data;    // [128]
    for (let i = 0; i < 128; i++) {
      let sum = b2[i];
      const row = i * 256;
      for (let j = 0; j < 256; j++) {
        sum += w2[row + j] * buf.l1[j];
      }
      buf.l2[i] = sum > 0 ? sum : Math.expm1(sum);
    }

    // Layer 3: Linear(128 → 29) (no activation)
    const w3 = w['mlp.6.weight'].data;  // [29, 128]
    const b3 = w['mlp.6.bias'].data;    // [29]
    for (let i = 0; i < 29; i++) {
      let sum = b3[i];
      const row = i * 128;
      for (let j = 0; j < 128; j++) {
        sum += w3[row + j] * buf.l2[j];
      }
      this._outputBuffer[i] = sum;
    }

    return this._outputBuffer;
  }

  _applyAction(actionData, data) {
    const cfg = this.config;
    const ctrlMap = cfg.action_to_ctrl_map;
    for (let i = 0; i < cfg.num_joints; i++) {
      this.lastAction[i] = actionData[i];
    }
    for (let i = 0; i < cfg.num_joints; i++) {
      const ctrlIdx = ctrlMap ? ctrlMap[i] : i;
      data.ctrl[ctrlIdx] =
        actionData[i] * cfg.action_scale[i] + cfg.default_joint_pos[i];
    }
  }

  _updateArrows() {
    if (!this._arrows) return;

    const data = this.viewer.getData();
    const rp = [data.qpos[0], data.qpos[1], data.qpos[2]];
    const rq = [data.qpos[3], data.qpos[4], data.qpos[5], data.qpos[6]];

    const Z_OFFSET = 0.6;
    const SCALE = 0.5;

    // Arrow base: robot pos + rotated [0, 0, Z_OFFSET] in world frame.
    const bo = _rotByQuat(rq, [0, 0, Z_OFFSET]);
    const base = _toThree(rp[0] + bo[0], rp[1] + bo[1], rp[2] + bo[2]);

    // Command linear velocity.
    const cv = _rotByQuat(rq, [this.command[0] * SCALE, this.command[1] * SCALE, 0]);
    const cvT = _toThree(cv[0], cv[1], cv[2]);
    _setArrow(this._arrows.cmdLin, base, cvT, cvT.length());

    // Actual linear velocity from velocimeter sensor.
    const va = this.sensorAddrs.velocimeter;
    if (va !== undefined) {
      const av = _rotByQuat(rq, [
        data.sensordata[va] * SCALE,
        data.sensordata[va + 1] * SCALE,
        0,
      ]);
      const avT = _toThree(av[0], av[1], av[2]);
      _setArrow(this._arrows.actLin, base, avT, avT.length());
    }

    // Command angular velocity (vertical arrow).
    const cw = _rotByQuat(rq, [0, 0, this.command[2] * SCALE]);
    const cwT = _toThree(cw[0], cw[1], cw[2]);
    _setArrow(this._arrows.cmdAng, base, cwT, cwT.length());

    // Actual angular velocity from gyro sensor (Z component).
    const ga = this.sensorAddrs.gyro;
    if (ga !== undefined) {
      const aw = _rotByQuat(rq, [0, 0, data.sensordata[ga + 2] * SCALE]);
      const awT = _toThree(aw[0], aw[1], aw[2]);
      _setArrow(this._arrows.actAng, base, awT, awT.length());
    }
  }

  _resolveSensorAddresses() {
    const model = this.viewer.getModel();
    const cfg = this.config;

    const namesBuf = model.names;
    const decoder = new TextDecoder();

    for (let i = 0; i < model.nsensor; i++) {
      const nameStart = model.name_sensoradr[i];
      let nameEnd = nameStart;
      while (nameEnd < namesBuf.length && namesBuf[nameEnd] !== 0) {
        nameEnd++;
      }
      const name = decoder.decode(namesBuf.subarray(nameStart, nameEnd));
      const addr = model.sensor_adr[i];

      if (name === cfg.sensor_gyro || name.endsWith("imu_ang_vel")) {
        this.sensorAddrs.gyro = addr;
      }
      if (
        name === cfg.sensor_velocimeter ||
        name.endsWith("imu_lin_vel")
      ) {
        this.sensorAddrs.velocimeter = addr;
      }
    }

    if (this.sensorAddrs.gyro === undefined) {
      console.error("Gyro sensor not found in model.");
    }
    if (this.sensorAddrs.velocimeter === undefined) {
      console.error("Velocimeter sensor not found in model.");
    }
  }
}
