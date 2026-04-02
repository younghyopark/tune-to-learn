/**
 * ONNX policy inference runner for MuJoCo WASM.
 *
 * Constructs observations from MuJoCo state, runs ONNX inference,
 * and applies actions back to the simulation at 50Hz (configurable).
 *
 * Supports both velocity (locomotion) and manipulation tasks.
 *
 * Usage:
 *   const runner = new PolicyRunner(viewer, config);
 *   await runner.init("policy.onnx");
 *   runner.initArrows();
 *   runner.start();
 *   runner.setCommand([0.5, 0, 0]); // Walk forward
 */

import * as THREE from "three";
import {
  rotateVectorByQuatInverse,
  quatBoxMinus,
  quatFromEulerXYZ,
} from "./mujoco_utils.js";

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

function _sampleUniform(lo, hi) {
  return lo + Math.random() * (hi - lo);
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
    this.lastAction = new Float32Array(config.num_actions ?? config.num_joints);
    this.obsDim = config.observation_dims.reduce((a, b) => a + b, 0);

    this._animFrameId = null;
    this._running = false;
    this._policyIntervalMs =
      config.timestep * config.decimation * 1000; // 20ms default
    this._arrows = null;

    // Manipulation command state.
    this.commandTarget = null;
    this._commandResampleTimer = null;

    // Reorientation command state.
    this._reorientCfg = null;
    this._reorientTarget = null; // [x, y, z]
    this._reorientTargetQuat = null; // [w, x, y, z]

    // Observation history buffers (for terms with history_length > 1).
    this._historyBuffers = this._initHistoryBuffers();

    this.realtime = true;
  }

  _initHistoryBuffers() {
    const cfg = this.config;
    const lengths = cfg.observation_history_lengths;
    if (!lengths) return null;

    const buffers = [];
    for (let i = 0; i < cfg.observation_order.length; i++) {
      const hl = lengths[i] || 1;
      if (hl <= 1) {
        buffers.push(null);
        continue;
      }
      const baseDim = cfg.observation_dims[i] / hl;
      buffers.push({
        historyLength: hl,
        baseDim,
        data: new Float32Array(hl * baseDim), // oldest → newest
        needsBackfill: true,
      });
    }
    return buffers;
  }

  /** Load the ONNX model and resolve sensor addresses. */
  async init(onnxPath) {
    const ort = await import("onnxruntime-web");

    this.session = await ort.InferenceSession.create(onnxPath, {
      executionProviders: ["wasm"],
    });

    this._resolveSensorAddresses();
    this._initManipulationCommands();
    this._ort = ort;
  }

  /** Create velocity arrow visualizations in the Three.js scene. */
  initArrows() {
    if (this.config.task_type === "manipulation") {
      this._initGoalMarker();
      return;
    }

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

    const simDtMs = this.config.timestep * 1000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const animate = async () => {
      if (!this._running) return;
      this._animFrameId = requestAnimationFrame(animate);

      if (busy) return;
      busy = true;

      const obs = this.buildObservation();
      const action = await this._runInference(obs);
      this._applyAction(action, data);

      this.viewer.updateDragForces();

      for (let i = 0; i < this.config.decimation; i++) {
        const t0 = performance.now();
        mujoco.mj_step(model, data);
        if (this.realtime) {
          const elapsed = performance.now() - t0;
          if (elapsed < simDtMs) {
            await sleep(simDtMs - elapsed);
          }
        }
      }

      // Check early termination (cube drop / velocity exceeded).
      if (this._checkTerminations(data)) {
        this.reset();
      }

      this._updateArrows();
      this._updateGoalMarker();
      this._updateSuccessIndicator();
      this._checkReorientSuccess(data);
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
    if (this._commandResampleTimer !== null) {
      clearInterval(this._commandResampleTimer);
      this._commandResampleTimer = null;
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
    // Reset history buffers.
    if (this._historyBuffers) {
      for (const buf of this._historyBuffers) {
        if (buf) {
          buf.data.fill(0);
          buf.needsBackfill = true;
        }
      }
    }
    if (this._reorientCfg) {
      this._consecutiveAtGoal = 0;
      if (this._reorientCfg.type === "inhand_reorientation") {
        this._resampleInhandReorientCommand(false);
      } else {
        this._resampleReorientCommand(false);
      }
      this._resetReorientTimer();
    } else if (this.config.command_config) {
      this._resampleManipulationCommand();
    }
  }

  /**
   * Build the observation vector from MuJoCo state.
   * Matches the Python observation pipeline exactly.
   * Supports observation history stacking (history_length > 1).
   * @returns {Float32Array}
   */
  buildObservation() {
    const data = this.viewer.getData();
    const cfg = this.config;
    const obs = new Float32Array(this.obsDim);
    let offset = 0;

    for (let termIdx = 0; termIdx < cfg.observation_order.length; termIdx++) {
      const term = cfg.observation_order[termIdx];
      const dim = cfg.observation_dims[termIdx];
      const histBuf = this._historyBuffers?.[termIdx];

      // For history terms, compute into a temp buffer; otherwise write
      // directly into the output observation.
      const baseDim = histBuf ? histBuf.baseDim : dim;
      const target = histBuf ? new Float32Array(baseDim) : obs;
      const tOff = histBuf ? 0 : offset;

      switch (term) {
        case "base_lin_vel": {
          const addr = this.sensorAddrs.velocimeter;
          if (addr !== undefined) {
            target[tOff + 0] = data.sensordata[addr + 0];
            target[tOff + 1] = data.sensordata[addr + 1];
            target[tOff + 2] = data.sensordata[addr + 2];
          }
          break;
        }

        case "base_ang_vel": {
          const addr = this.sensorAddrs.gyro;
          if (addr !== undefined) {
            target[tOff + 0] = data.sensordata[addr + 0];
            target[tOff + 1] = data.sensordata[addr + 1];
            target[tOff + 2] = data.sensordata[addr + 2];
          }
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
          target[tOff + 0] = pg[0];
          target[tOff + 1] = pg[1];
          target[tOff + 2] = pg[2];
          break;
        }

        case "joint_pos": {
          const qOff = cfg.qpos_joint_offset;
          for (let i = 0; i < baseDim; i++) {
            target[tOff + i] =
              data.qpos[qOff + i] - cfg.default_joint_pos[i];
          }
          break;
        }

        case "joint_vel": {
          const vOff = cfg.qvel_joint_offset;
          for (let i = 0; i < baseDim; i++) {
            target[tOff + i] = data.qvel[vOff + i];
          }
          break;
        }

        case "actions": {
          for (let i = 0; i < baseDim; i++) {
            target[tOff + i] = this.lastAction[i];
          }
          break;
        }

        case "command": {
          target[tOff + 0] = this.command[0];
          target[tOff + 1] = this.command[1];
          target[tOff + 2] = this.command[2];
          break;
        }

        case "height_scan": {
          // Zero-filled (no ray casting in browser).
          break;
        }

        case "ee_to_cube": {
          this._fillEeToCube(target, tOff, data, cfg);
          break;
        }

        case "cube_to_goal": {
          this._fillCubeToGoal(target, tOff, data, cfg);
          break;
        }

        case "cube_orientation": {
          this._fillCubeOrientation(target, tOff, data, cfg);
          break;
        }

        case "cube_to_target_pos": {
          this._fillCubeToTargetPos(target, tOff, data, cfg);
          break;
        }

        case "cube_orientation_to_target": {
          this._fillCubeOrientationToTarget(target, tOff, data, cfg);
          break;
        }

        default:
          console.warn(`Unknown observation term: ${term}`);
          break;
      }

      // Apply history stacking if this term has a history buffer.
      if (histBuf) {
        const hl = histBuf.historyLength;
        const bd = histBuf.baseDim;
        if (histBuf.needsBackfill) {
          // Fill all history slots with the current value.
          for (let h = 0; h < hl; h++) {
            histBuf.data.set(target, h * bd);
          }
          histBuf.needsBackfill = false;
        } else {
          // Shift left by baseDim (drop oldest), append newest.
          histBuf.data.copyWithin(0, bd);
          histBuf.data.set(target, (hl - 1) * bd);
        }
        // Copy full history into the observation (oldest → newest).
        obs.set(histBuf.data, offset);
      }

      // Always advance offset by the declared dim.
      offset += dim;
    }

    return obs;
  }

  // ── Private methods ──────────────────────────────────

  _fillEeToCube(obs, offset, data, cfg) {
    const params = cfg.observation_term_params?.["ee_to_cube"];
    if (!params) return;

    // Get site and body IDs from the pre-computed lookup tables.
    const siteName = `${params.entity_name}/${params.site_names[0]}`;
    const siteId = cfg.site_ids[siteName];

    // Object body: entity prefix + body name.
    const objKey = params.object_name;
    const bodyName = `${objKey}/${objKey}`;
    const bodyId = cfg.body_ids[bodyName];

    if (siteId === undefined || bodyId === undefined) return;

    // ee position from data.site_xpos.
    const eeX = data.site_xpos[siteId * 3 + 0];
    const eeY = data.site_xpos[siteId * 3 + 1];
    const eeZ = data.site_xpos[siteId * 3 + 2];

    // object position from data.xpos.
    const objX = data.xpos[bodyId * 3 + 0];
    const objY = data.xpos[bodyId * 3 + 1];
    const objZ = data.xpos[bodyId * 3 + 2];

    let dx = objX - eeX;
    let dy = objY - eeY;
    let dz = objZ - eeZ;

    // Rotate into base frame.
    if (!cfg.is_fixed_base) {
      const rootBodyName = `${params.entity_name}/${params.entity_name}`;
      const rootId = cfg.body_ids[rootBodyName];
      if (rootId !== undefined) {
        const q = [
          data.xquat[rootId * 4 + 0],
          data.xquat[rootId * 4 + 1],
          data.xquat[rootId * 4 + 2],
          data.xquat[rootId * 4 + 3],
        ];
        [dx, dy, dz] = rotateVectorByQuatInverse([dx, dy, dz], q);
      }
    }

    obs[offset + 0] = dx;
    obs[offset + 1] = dy;
    obs[offset + 2] = dz;
  }

  _fillCubeToGoal(obs, offset, data, cfg) {
    const params = cfg.observation_term_params?.["cube_to_goal"];
    if (!params || !this.commandTarget) return;

    const objKey = params.object_name;
    const bodyName = `${objKey}/${objKey}`;
    const bodyId = cfg.body_ids[bodyName];
    if (bodyId === undefined) return;

    const objX = data.xpos[bodyId * 3 + 0];
    const objY = data.xpos[bodyId * 3 + 1];
    const objZ = data.xpos[bodyId * 3 + 2];

    let dx = this.commandTarget[0] - objX;
    let dy = this.commandTarget[1] - objY;
    let dz = this.commandTarget[2] - objZ;

    // Rotate into base frame.
    if (!cfg.is_fixed_base) {
      // Find the robot's root body for the rotation.
      const robotParams = cfg.observation_term_params?.["ee_to_cube"];
      if (robotParams) {
        const rootName = `${robotParams.entity_name}/${robotParams.entity_name}`;
        const rootId = cfg.body_ids[rootName];
        if (rootId !== undefined) {
          const q = [
            data.xquat[rootId * 4 + 0],
            data.xquat[rootId * 4 + 1],
            data.xquat[rootId * 4 + 2],
            data.xquat[rootId * 4 + 3],
          ];
          [dx, dy, dz] = rotateVectorByQuatInverse([dx, dy, dz], q);
        }
      }
    }

    obs[offset + 0] = dx;
    obs[offset + 1] = dy;
    obs[offset + 2] = dz;
  }

  _fillCubeOrientation(obs, offset, data, cfg) {
    const params = cfg.observation_term_params?.["cube_orientation"];
    if (!params) return;

    const objKey = params.object_name;
    const bodyName = `${objKey}/${objKey}`;
    const bodyId = cfg.body_ids[bodyName];
    if (bodyId === undefined) return;

    // Cube quaternion (w, x, y, z).
    const q = [
      data.xquat[bodyId * 4 + 0],
      data.xquat[bodyId * 4 + 1],
      data.xquat[bodyId * 4 + 2],
      data.xquat[bodyId * 4 + 3],
    ];

    // Rotate basis vectors by cube quaternion → local axes in world frame.
    const axes = [
      _rotByQuat(q, [1, 0, 0]),
      _rotByQuat(q, [0, 1, 0]),
      _rotByQuat(q, [0, 0, 1]),
    ];

    // Most-vertical axis (max |z|) → tilt.
    let vertIdx = 0;
    let maxAbsZ = Math.abs(axes[0][2]);
    for (let i = 1; i < 3; i++) {
      const az = Math.abs(axes[i][2]);
      if (az > maxAbsZ) { maxAbsZ = az; vertIdx = i; }
    }
    const tilt = axes[vertIdx][2];

    // Most-horizontal axis (min |z|) → yaw.
    let horizIdx = 0;
    let minAbsZ = Math.abs(axes[0][2]);
    for (let i = 1; i < 3; i++) {
      const az = Math.abs(axes[i][2]);
      if (az < minAbsZ) { minAbsZ = az; horizIdx = i; }
    }
    let hAxis = axes[horizIdx];

    // Rotate into robot base frame (skip for fixed-base).
    if (!cfg.is_fixed_base) {
      const robotParams = cfg.observation_term_params?.["ee_to_cube"];
      if (robotParams) {
        const rootName = `${robotParams.entity_name}/${robotParams.entity_name}`;
        const rootId = cfg.body_ids[rootName];
        if (rootId !== undefined) {
          const rq = [
            data.xquat[rootId * 4 + 0],
            data.xquat[rootId * 4 + 1],
            data.xquat[rootId * 4 + 2],
            data.xquat[rootId * 4 + 3],
          ];
          hAxis = rotateVectorByQuatInverse(hAxis, rq);
        }
      }
    }

    // cos(4θ), sin(4θ) via double-angle identities.
    const hx = hAxis[0];
    const hy = hAxis[1];
    const r2 = Math.max(hx * hx + hy * hy, 1e-8);
    const cos2 = (hx * hx - hy * hy) / r2;
    const sin2 = (2.0 * hx * hy) / r2;

    obs[offset + 0] = cos2 * cos2 - sin2 * sin2; // cos(4θ)
    obs[offset + 1] = 2.0 * sin2 * cos2;          // sin(4θ)
    obs[offset + 2] = tilt;
  }

  _fillCubeToTargetPos(obs, offset, data, cfg) {
    const params = cfg.observation_term_params?.["cube_to_target_pos"];
    if (!params || !this._reorientTarget) return;

    const objKey = params.object_name || params.entity_name;
    const bodyName = `${objKey}/${objKey}`;
    const bodyId = cfg.body_ids[bodyName];
    if (bodyId === undefined) return;

    const objX = data.xpos[bodyId * 3 + 0];
    const objY = data.xpos[bodyId * 3 + 1];
    const objZ = data.xpos[bodyId * 3 + 2];

    obs[offset + 0] = this._reorientTarget[0] - objX;
    obs[offset + 1] = this._reorientTarget[1] - objY;
    obs[offset + 2] = this._reorientTarget[2] - objZ;
  }

  _fillCubeOrientationToTarget(obs, offset, data, cfg) {
    const params = cfg.observation_term_params?.["cube_orientation_to_target"];
    if (!params || !this._reorientTargetQuat) return;

    const objKey = params.object_name || params.entity_name;
    const bodyName = `${objKey}/${objKey}`;
    const bodyId = cfg.body_ids[bodyName];
    if (bodyId === undefined) return;

    // Cube quaternion (w, x, y, z) from MuJoCo xquat.
    const cubeQuat = [
      data.xquat[bodyId * 4 + 0],
      data.xquat[bodyId * 4 + 1],
      data.xquat[bodyId * 4 + 2],
      data.xquat[bodyId * 4 + 3],
    ];

    // quat_box_minus(target, current) → axis-angle error.
    const aa = quatBoxMinus(this._reorientTargetQuat, cubeQuat);
    obs[offset + 0] = aa[0];
    obs[offset + 1] = aa[1];
    obs[offset + 2] = aa[2];
  }

  async _runInference(observation) {
    const inputTensor = new this._ort.Tensor(
      "float32",
      observation,
      [1, this.obsDim],
    );
    const feeds = { [this.config.onnx_input_name]: inputTensor };
    const results = await this.session.run(feeds);
    return results[this.config.onnx_output_name].data;
  }

  _applyAction(actionData, data) {
    const cfg = this.config;
    const ctrlMap = cfg.action_to_ctrl_map;
    const nAct = cfg.num_actions ?? cfg.num_joints;
    // action_default_pos has one entry per actuated joint; fall back to
    // default_joint_pos for backward compat with old configs.
    const actDefault = cfg.action_default_pos ?? cfg.default_joint_pos;
    const isRelCurrent = cfg.action_mode === "rel_current_pos";
    for (let i = 0; i < nAct; i++) {
      this.lastAction[i] = actionData[i];
    }
    for (let i = 0; i < nAct; i++) {
      const ctrlIdx = ctrlMap ? ctrlMap[i] : i;
      if (isRelCurrent) {
        // target = current_joint_pos + scale * action
        const currentPos = data.qpos[cfg.qpos_joint_offset + i];
        data.ctrl[ctrlIdx] =
          currentPos + actionData[i] * cfg.action_scale[i];
      } else {
        data.ctrl[ctrlIdx] =
          actionData[i] * cfg.action_scale[i] + actDefault[i];
      }
    }
    // Apply fixed-position actuators (e.g. gripper always closed).
    if (cfg.fixed_ctrl) {
      for (const [idx, val] of Object.entries(cfg.fixed_ctrl)) {
        data.ctrl[parseInt(idx)] = val;
      }
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

    // Skip if no sensor fields in config.
    if (!cfg.sensor_gyro && !cfg.sensor_velocimeter) return;

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

    if (cfg.sensor_gyro && this.sensorAddrs.gyro === undefined) {
      console.warn("Gyro sensor not found in model.");
    }
    if (cfg.sensor_velocimeter && this.sensorAddrs.velocimeter === undefined) {
      console.warn("Velocimeter sensor not found in model.");
    }
  }

  // ── Manipulation command management ──────────────────

  _initManipulationCommands() {
    const cmdCfg = this.config.command_config;
    if (!cmdCfg) return;

    for (const [, cfg] of Object.entries(cmdCfg)) {
      if (cfg.type === "lifting") {
        this._liftingCfg = cfg;
        this._resampleManipulationCommand();

        const range = cfg.resampling_time_range || [8, 12];
        const intervalMs = _sampleUniform(range[0], range[1]) * 1000;
        this._commandResampleTimer = setInterval(() => {
          this._resampleManipulationCommand();
        }, intervalMs);
        break;
      }

      if (cfg.type === "reorientation") {
        this._reorientCfg = cfg;
        const tp = cfg.target_pose;
        this._reorientTarget = [tp.x, tp.y, tp.z];
        this._reorientTargetQuat = quatFromEulerXYZ(0, 0, tp.yaw);
        this.commandTarget = this._reorientTarget;
        this._consecutiveAtGoal = 0;
        this._resampleReorientCommand();
        this._resetReorientTimer();

        // Prevent dragging the target entity.
        const bodyIds = this.config.body_ids;
        if (bodyIds && cfg.target_entity_name) {
          const excluded = new Set();
          for (const [name, id] of Object.entries(bodyIds)) {
            if (name.startsWith(cfg.target_entity_name + "/")) {
              excluded.add(id);
            }
          }
          if (excluded.size > 0) this.viewer.setNoDragBodies(excluded);
        }
        break;
      }

      if (cfg.type === "inhand_reorientation") {
        this._reorientCfg = cfg;
        const sp = cfg.spawn_pos;
        this._reorientTarget = [sp[0], sp[1], sp[2]];
        this._reorientTargetQuat = quatFromEulerXYZ(0, 0, 0);
        this.commandTarget = this._reorientTarget;
        this._consecutiveAtGoal = 0;
        this._resampleInhandReorientCommand(false);
        this._resetReorientTimer();

        // Prevent dragging the target entity.
        const bodyIds = this.config.body_ids;
        if (bodyIds && cfg.target_entity_name) {
          const excluded = new Set();
          for (const [name, id] of Object.entries(bodyIds)) {
            if (name.startsWith(cfg.target_entity_name + "/")) {
              excluded.add(id);
            }
          }
          if (excluded.size > 0) this.viewer.setNoDragBodies(excluded);
        }
        break;
      }
    }
  }

  _resampleManipulationCommand() {
    const cfg = this._liftingCfg;
    if (!cfg) return;

    // Sample new target position.
    const r = cfg.target_position_range;
    this.commandTarget = [
      _sampleUniform(r.x[0], r.x[1]),
      _sampleUniform(r.y[0], r.y[1]),
      _sampleUniform(r.z[0], r.z[1]),
    ];

    // Reset cube to random position if object_pose_range is set.
    if (cfg.object_pose_range) {
      this._resetCubePosition(cfg.object_pose_range);
    }
  }

  _resetCubePosition(poseRange) {
    const data = this.viewer.getData();
    const bodyCfg = this.config;

    // Find the cube's qpos offset. The cube has a freejoint, so its
    // qpos is 7 values: [x, y, z, qw, qx, qy, qz].
    // We need to find which qpos index the cube starts at.
    // For a scene with robot (fixed-base) + cube (freejoint),
    // the cube's freejoint qpos starts after the robot's joints.
    const cubeQposOffset = bodyCfg.qpos_joint_offset + bodyCfg.num_joints;

    const x = _sampleUniform(poseRange.x[0], poseRange.x[1]);
    const y = _sampleUniform(poseRange.y[0], poseRange.y[1]);
    const z = _sampleUniform(poseRange.z[0], poseRange.z[1]);

    // Set position.
    data.qpos[cubeQposOffset + 0] = x;
    data.qpos[cubeQposOffset + 1] = y;
    data.qpos[cubeQposOffset + 2] = z;

    // Set orientation (yaw only, keep upright).
    const yaw = _sampleUniform(poseRange.yaw[0], poseRange.yaw[1]);
    const cy = Math.cos(yaw * 0.5);
    const sy = Math.sin(yaw * 0.5);
    data.qpos[cubeQposOffset + 3] = cy; // qw
    data.qpos[cubeQposOffset + 4] = 0;  // qx
    data.qpos[cubeQposOffset + 5] = 0;  // qy
    data.qpos[cubeQposOffset + 6] = sy; // qz

    // Zero velocities for the cube freejoint (6 values).
    const cubeQvelOffset = bodyCfg.qvel_joint_offset + bodyCfg.num_joints;
    for (let i = 0; i < 6; i++) {
      data.qvel[cubeQvelOffset + i] = 0;
    }
  }

  // ── Reorientation command management ──────────────────

  /**
   * Resample the reorientation command (target pose + optional cube reset).
   * @param {boolean} goalOnly - If true, only resample the target; cube stays.
   */
  _resampleReorientCommand(goalOnly = false) {
    const cfg = this._reorientCfg;
    if (!cfg) return;

    const data = this.viewer.getData();
    const offsets = this.config.entity_qpos_offsets;
    const velOffsets = this.config.entity_qvel_offsets;

    // Sample target pose (randomized if ranges are non-zero).
    const tp = cfg.target_pose;
    const _hasRange = (r) => r && (r[0] !== 0 || r[1] !== 0);
    const goalX = tp.x + (_hasRange(tp.x_range)
      ? _sampleUniform(tp.x_range[0], tp.x_range[1]) : 0);
    const goalY = tp.y + (_hasRange(tp.y_range)
      ? _sampleUniform(tp.y_range[0], tp.y_range[1]) : 0);
    const goalZ = tp.z;

    let goalYaw = tp.yaw;
    if (_hasRange(tp.yaw_range)) {
      goalYaw = _sampleUniform(tp.yaw_range[0], tp.yaw_range[1]);
    }
    let goalRoll = 0;
    let goalPitch = 0;
    if (tp.roll_pitch_prob > 0 && Math.random() < tp.roll_pitch_prob) {
      const rc = tp.roll_choices || [0];
      const pc = tp.pitch_choices || [0];
      goalRoll = rc[Math.floor(Math.random() * rc.length)];
      goalPitch = pc[Math.floor(Math.random() * pc.length)];
    }
    const goalQuat = quatFromEulerXYZ(goalRoll, goalPitch, goalYaw);

    // Update cached target for observation/visualization.
    this._reorientTarget = [goalX, goalY, goalZ];
    this._reorientTargetQuat = goalQuat;
    this.commandTarget = this._reorientTarget;

    // Position target_cube at the sampled goal pose.
    const targetOff = offsets?.[cfg.target_entity_name];
    if (targetOff !== undefined) {
      data.qpos[targetOff + 0] = goalX;
      data.qpos[targetOff + 1] = goalY;
      data.qpos[targetOff + 2] = goalZ;
      data.qpos[targetOff + 3] = goalQuat[0];
      data.qpos[targetOff + 4] = goalQuat[1];
      data.qpos[targetOff + 5] = goalQuat[2];
      data.qpos[targetOff + 6] = goalQuat[3];
      // Zero target_cube velocity.
      const tvOff = velOffsets?.[cfg.target_entity_name];
      if (tvOff !== undefined) {
        for (let i = 0; i < 6; i++) data.qvel[tvOff + i] = 0;
      }
    }

    // Goal-only resample: skip cube reset.
    if (goalOnly) return;

    // Spawn actual cube at random offset from target.
    const cubeOff = offsets?.[cfg.entity_name];
    if (cubeOff === undefined) return;

    const sr = cfg.spawn_offset;
    const ox = _sampleUniform(sr.x[0], sr.x[1]);
    const oy = _sampleUniform(sr.y[0], sr.y[1]);
    data.qpos[cubeOff + 0] = goalX + ox;
    data.qpos[cubeOff + 1] = goalY + oy;
    data.qpos[cubeOff + 2] = goalZ;

    // Random yaw.
    const spawnYaw = _sampleUniform(sr.yaw[0], sr.yaw[1]);
    // Optional roll/pitch from discrete choices.
    let spawnRoll = 0;
    let spawnPitch = 0;
    if (sr.roll_pitch_prob > 0 && Math.random() < sr.roll_pitch_prob) {
      const rc = sr.roll_choices;
      const pc = sr.pitch_choices;
      spawnRoll = rc[Math.floor(Math.random() * rc.length)];
      spawnPitch = pc[Math.floor(Math.random() * pc.length)];
    }
    const sq = quatFromEulerXYZ(spawnRoll, spawnPitch, spawnYaw);
    data.qpos[cubeOff + 3] = sq[0];
    data.qpos[cubeOff + 4] = sq[1];
    data.qpos[cubeOff + 5] = sq[2];
    data.qpos[cubeOff + 6] = sq[3];

    // Zero cube velocity.
    const cvOff = velOffsets?.[cfg.entity_name];
    if (cvOff !== undefined) {
      for (let i = 0; i < 6; i++) data.qvel[cvOff + i] = 0;
    }
  }

  // ── In-hand reorientation command management ─────────

  /**
   * Resample for in-hand reorientation: cube stays at spawn_pos,
   * target displayed separately. Target gets random yaw (+ optional
   * roll/pitch); cube gets random yaw ≥ min_yaw_distance from target.
   * @param {boolean} goalOnly - If true, only resample target orientation.
   */
  _resampleInhandReorientCommand(goalOnly = false) {
    const cfg = this._reorientCfg;
    if (!cfg) return;

    const data = this.viewer.getData();
    const offsets = this.config.entity_qpos_offsets;
    const velOffsets = this.config.entity_qvel_offsets;

    // Sample target orientation: always random yaw, optional roll/pitch.
    const goalYaw = Math.random() * 2 * Math.PI - Math.PI;
    let goalRoll = 0;
    let goalPitch = 0;
    const prob = cfg.full_orientation_prob || 0;
    if (prob > 0 && Math.random() < prob) {
      const rc = cfg.roll_choices || [0];
      const pc = cfg.pitch_choices || [0];
      goalRoll = rc[Math.floor(Math.random() * rc.length)];
      goalPitch = pc[Math.floor(Math.random() * pc.length)];
    }
    const goalQuat = quatFromEulerXYZ(goalRoll, goalPitch, goalYaw);

    // Cache for observation computation.
    const sp = cfg.spawn_pos;
    this._reorientTarget = [sp[0], sp[1], sp[2]];
    this._reorientTargetQuat = goalQuat;
    this.commandTarget = this._reorientTarget;

    // Place target_cube with target orientation.
    // For inhand tasks, position it next to the actual cube at the same
    // height (updated each frame in _updateTargetCubePosition).
    // For other tasks, use the static display position.
    const targetOff = offsets?.[cfg.target_entity_name];
    if (targetOff !== undefined) {
      const dp = cfg.target_display_pos;
      data.qpos[targetOff + 0] = dp[0];
      data.qpos[targetOff + 1] = dp[1];
      data.qpos[targetOff + 2] = dp[2];
      data.qpos[targetOff + 3] = goalQuat[0];
      data.qpos[targetOff + 4] = goalQuat[1];
      data.qpos[targetOff + 5] = goalQuat[2];
      data.qpos[targetOff + 6] = goalQuat[3];
      const tvOff = velOffsets?.[cfg.target_entity_name];
      if (tvOff !== undefined) {
        for (let i = 0; i < 6; i++) data.qvel[tvOff + i] = 0;
      }
    }

    if (goalOnly) return;

    // Spawn cube at spawn_pos with random yaw ≥ min_yaw_distance
    // from target yaw.
    const cubeOff = offsets?.[cfg.entity_name];
    if (cubeOff === undefined) return;

    const minDist = cfg.min_yaw_distance || 0;
    let spawnYaw;
    for (let attempt = 0; attempt < 100; attempt++) {
      spawnYaw = Math.random() * 2 * Math.PI - Math.PI;
      let diff = spawnYaw - goalYaw;
      // Wrap to [-π, π].
      diff = diff - 2 * Math.PI * Math.round(diff / (2 * Math.PI));
      if (Math.abs(diff) >= minDist) break;
    }
    const spawnQuat = quatFromEulerXYZ(0, 0, spawnYaw);
    data.qpos[cubeOff + 0] = sp[0];
    data.qpos[cubeOff + 1] = sp[1];
    data.qpos[cubeOff + 2] = sp[2];
    data.qpos[cubeOff + 3] = spawnQuat[0];
    data.qpos[cubeOff + 4] = spawnQuat[1];
    data.qpos[cubeOff + 5] = spawnQuat[2];
    data.qpos[cubeOff + 6] = spawnQuat[3];

    const cvOff = velOffsets?.[cfg.entity_name];
    if (cvOff !== undefined) {
      for (let i = 0; i < 6; i++) data.qvel[cvOff + i] = 0;
    }
  }

  // ── Reorientation timer + success-based resampling ───

  _resetReorientTimer() {
    const range = this._reorientCfg?.resampling_time_range;
    if (range) {
      this._reorientTimeLeft = _sampleUniform(range[0], range[1]);
    } else {
      this._reorientTimeLeft = 10.0;
    }
  }

  /**
   * Check early termination conditions. Returns true if terminated.
   * Mirrors Python termination terms: cube_dropped, cube_velocity.
   */
  _checkTerminations(data) {
    const cfg = this._reorientCfg;
    if (!cfg) return false;

    const offsets = this.config.entity_qpos_offsets;
    const velOffsets = this.config.entity_qvel_offsets;
    const cubeQposOff = offsets?.[cfg.entity_name];
    const cubeQvelOff = velOffsets?.[cfg.entity_name];
    if (cubeQposOff === undefined) return false;

    // Cube dropped: z position below threshold.
    const cubeZ = data.qpos[cubeQposOff + 2];
    const zThreshold = cfg.termination_z_threshold ?? 0.1;
    if (cubeZ < zThreshold) return true;

    // Cube velocity exceeded: linear speed too high.
    if (cubeQvelOff !== undefined) {
      const vx = data.qvel[cubeQvelOff + 0];
      const vy = data.qvel[cubeQvelOff + 1];
      const vz = data.qvel[cubeQvelOff + 2];
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const maxSpeed = cfg.termination_max_speed ?? 5.0;
      if (speed > maxSpeed) return true;
    }

    return false;
  }

  /**
   * Called each policy step. Mirrors the Python compute() logic:
   *  1. Decrement time_left; if expired → full resample (target + cube).
   *  2. If resample_on_success: check sustained success → goal-only resample
   *     + reset timer.
   */
  _checkReorientSuccess(data) {
    const cfg = this._reorientCfg;
    if (!cfg) return;

    const stepDt = this.config.timestep * this.config.decimation;

    // Pause timer and success counting while user is dragging.
    if (this.viewer.isDragging()) return;

    const isInhand = cfg.type === "inhand_reorientation";
    const resample = (goalOnly) => isInhand
      ? this._resampleInhandReorientCommand(goalOnly)
      : this._resampleReorientCommand(goalOnly);

    // 1. Timer countdown → full resample (both target and cube).
    if (this._reorientTimeLeft !== undefined) {
      this._reorientTimeLeft -= stepDt;
      if (this._reorientTimeLeft <= 0) {
        this._consecutiveAtGoal = 0;
        resample(false);
        this._resetReorientTimer();
        return; // Already resampled, skip success check this step.
      }
    }

    // 2. Success-based resampling (goal-only when configured).
    if (!cfg.resample_on_success) return;

    const offsets = this.config.entity_qpos_offsets;
    const cubeOff = offsets?.[cfg.entity_name];
    const targetOff = offsets?.[cfg.target_entity_name];
    if (cubeOff === undefined || targetOff === undefined) return;

    // Position error.
    const dx = data.qpos[cubeOff + 0] - data.qpos[targetOff + 0];
    const dy = data.qpos[cubeOff + 1] - data.qpos[targetOff + 1];
    const dz = data.qpos[cubeOff + 2] - data.qpos[targetOff + 2];
    const posErr = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Orientation error via quatBoxMinus (norm of axis-angle).
    const cq = [
      data.qpos[cubeOff + 3], data.qpos[cubeOff + 4],
      data.qpos[cubeOff + 5], data.qpos[cubeOff + 6],
    ];
    const tq = [
      data.qpos[targetOff + 3], data.qpos[targetOff + 4],
      data.qpos[targetOff + 5], data.qpos[targetOff + 6],
    ];
    const aa = quatBoxMinus(tq, cq);
    const oriErr = Math.sqrt(aa[0] * aa[0] + aa[1] * aa[1] + aa[2] * aa[2]);

    const posThr = cfg.position_threshold ?? 0.03;
    const oriThr = cfg.orientation_threshold ?? 0.0873;
    const atGoal = posErr < posThr && oriErr < oriThr;

    if (atGoal) {
      this._consecutiveAtGoal = (this._consecutiveAtGoal || 0) + 1;
    } else {
      this._consecutiveAtGoal = 0;
    }

    // Sustained success → resample (+ reset timer).
    const sustainedSteps = (cfg.sustained_success_duration ?? 0.1) / stepDt;
    if (this._consecutiveAtGoal >= sustainedSteps) {
      this._consecutiveAtGoal = 0;
      this._showSuccessIndicator();
      // In-hand: goal-only (new target, cube stays in hand).
      // Standard: uses the config flag.
      const goalOnly = isInhand ? true : !!cfg.resample_goal_only;
      resample(goalOnly);
      this._resetReorientTimer();
    }
  }

  // ── Goal marker visualization ────────────────────────

  _initGoalMarker() {
    const scene = this.viewer.getScene();
    if (!scene || !this.commandTarget) return;

    // Skip position goal marker for inhand tasks (position is fixed).
    const isInhand = this._reorientCfg?.type === "inhand_reorientation";
    if (!isInhand) {
      const geometry = new THREE.SphereGeometry(0.03, 16, 16);
      const material = new THREE.MeshPhongMaterial({
        color: 0xff8800,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      this._goalMarker = new THREE.Mesh(geometry, material);
      scene.add(this._goalMarker);
    }

    // Success indicator: green ring that flashes on sustained success.
    this._initSuccessIndicator(scene);

    // Color cube bodies with per-face colors for orientation tasks.
    this._colorCubeBodies();
  }

  _initSuccessIndicator(scene) {
    // Checkmark sprite rendered via canvas texture.
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Green circle background.
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(34, 197, 94, 0.85)";
    ctx.fill();

    // White checkmark.
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(32, 66);
    ctx.lineTo(54, 90);
    ctx.lineTo(96, 40);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    this._successSprite = new THREE.Sprite(mat);
    this._successSprite.scale.set(0.06, 0.06, 1);
    scene.add(this._successSprite);

    this._successFadeTime = 0;
  }

  _showSuccessIndicator() {
    this._successFadeTime = 0.8;
  }

  _updateSuccessIndicator() {
    if (!this._successSprite) return;
    if (this._successFadeTime <= 0) {
      this._successSprite.material.opacity = 0;
      return;
    }
    const stepDt = this.config.timestep * this.config.decimation;
    this._successFadeTime -= stepDt;
    const t = Math.max(0, this._successFadeTime);
    this._successSprite.material.opacity = Math.min(1, t / 0.2);

    // Position above actual cube (in Three.js Y-up coords).
    const cfg = this._reorientCfg;
    const cubeOff = this.config.entity_qpos_offsets?.[cfg?.entity_name];
    if (cubeOff !== undefined) {
      const data = this.viewer.getData();
      const cx = data.qpos[cubeOff + 0];
      const cy = data.qpos[cubeOff + 1];
      const cz = data.qpos[cubeOff + 2];
      this._successSprite.position.set(cx, cz + 0.08, -cy);
    }
  }

  /**
   * Replace cube mesh materials with labeled, per-face colored
   * textures so the orientation is visually distinguishable.
   *
   * Each face gets a distinct background color and a letter label
   * rendered via CanvasTexture.
   *
   * Three.js BoxGeometry group order (Y-up) mapped to MuJoCo (Z-up):
   *   0: +X, 1: -X, 2: +Y (=Mj +Z), 3: -Y (=Mj -Z),
   *   4: +Z (=Mj -Y), 5: -Z (=Mj +Y)
   */
  _colorCubeBodies() {
    const cmdCfg = this.config.command_config;
    if (!cmdCfg) return;

    const bodyIds = this.config.body_ids;
    const bodies = this.viewer.bodies;
    if (!bodies) return;

    // Face definitions: [bgColor, textColor, label]
    // Order follows Three.js BoxGeometry material groups.
    const faces = [
      ["#dd3333", "#fff", "R"],  // +X: Red
      ["#ff8800", "#fff", "L"],  // -X: Orange (Left)
      ["#eeeeee", "#333", "T"],  // +Y (Mj+Z): White (Top)
      ["#f0d000", "#333", "B"],  // -Y (Mj-Z): Yellow (Bottom)
      ["#3366dd", "#fff", "F"],  // +Z (Mj-Y): Blue (Front)
      ["#33aa33", "#fff", "K"],  // -Z (Mj+Y): Green (bacK)
    ];

    for (const cmd of Object.values(cmdCfg)) {
      if (cmd.type !== "reorientation" && cmd.type !== "inhand_reorientation") continue;

      const entries = [
        { entity: cmd.entity_name, opacity: 1.0 },
        { entity: cmd.target_entity_name, opacity: 0.3 },
      ];

      for (const { entity, opacity } of entries) {
        const bodyKey = Object.keys(bodyIds).find(
          (k) => k.startsWith(entity + "/"),
        );
        if (bodyKey === undefined) continue;
        const bid = bodyIds[bodyKey];
        const bodyGroup = bodies[bid];
        if (!bodyGroup) continue;

        const existingMesh = bodyGroup.children.find(
          (c) => c.isMesh,
        );
        if (!existingMesh) continue;

        existingMesh.geometry.computeBoundingBox();
        const bb = existingMesh.geometry.boundingBox;
        const sx = bb.max.x - bb.min.x;
        const sy = bb.max.y - bb.min.y;
        const sz = bb.max.z - bb.min.z;

        const materials = faces.map(([bg, fg, label]) => {
          const tex = this._makeLabelTexture(bg, fg, label);
          return new THREE.MeshPhysicalMaterial({
            map: tex,
            transparent: opacity < 1.0,
            opacity,
            roughness: 0.45,
            metalness: 0.1,
          });
        });

        const boxGeom = new THREE.BoxGeometry(sx, sy, sz);
        existingMesh.geometry.dispose();
        existingMesh.geometry = boxGeom;
        existingMesh.material = materials;
        existingMesh.castShadow = true;
        existingMesh.receiveShadow = true;
      }
    }
  }

  /** Render a colored square with a centered letter to a CanvasTexture. */
  _makeLabelTexture(bgColor, textColor, letter) {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Background.
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);

    // Letter.
    ctx.fillStyle = textColor;
    ctx.font = "bold 80px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, size / 2, size / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _updateGoalMarker() {
    if (!this._goalMarker || !this.commandTarget) return;
    // Convert MuJoCo (Z-up) to Three.js (Y-up).
    const [mx, my, mz] = this.commandTarget;
    this._goalMarker.position.set(mx, mz, -my);
  }

}
