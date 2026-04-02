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

    // Hardware constraint monitoring.
    this._constraintViolations = null; // Set per-frame: {pos, vel, accel, joints}
    this._prevArmVel = null;
    this._constraintEl = null; // DOM element for indicator.
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

    const animate = async () => {
      if (!this._running) return;
      this._animFrameId = requestAnimationFrame(animate);

      if (busy) return;
      busy = true;

      // One policy step per frame (runs at display refresh rate).
      const obs = this.buildObservation();
      const action = await this._runInference(obs);
      this._applyAction(action, data);

      // Apply drag forces (clears + reapplies qfrc_applied each step).
      this.viewer.updateDragForces();

      for (let i = 0; i < this.config.decimation; i++) {
        mujoco.mj_step(model, data);
      }

      this._updateArrows();
      this._updateGoalMarker();
      this.checkConstraints();
      this.updatePhasePlots();
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
    if (this._phaseTrail) {
      for (const t of this._phaseTrail) {
        t.idx = 0;
        t.len = 0;
      }
    }
    if (this.config.command_config) {
      this._resampleManipulationCommand();
    }
  }

  /**
   * Build the observation vector from MuJoCo state.
   * Matches the Python observation pipeline exactly.
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

      switch (term) {
        case "base_lin_vel": {
          const addr = this.sensorAddrs.velocimeter;
          if (addr !== undefined) {
            obs[offset + 0] = data.sensordata[addr + 0];
            obs[offset + 1] = data.sensordata[addr + 1];
            obs[offset + 2] = data.sensordata[addr + 2];
          }
          break;
        }

        case "base_ang_vel": {
          const addr = this.sensorAddrs.gyro;
          if (addr !== undefined) {
            obs[offset + 0] = data.sensordata[addr + 0];
            obs[offset + 1] = data.sensordata[addr + 1];
            obs[offset + 2] = data.sensordata[addr + 2];
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
          obs[offset + 0] = pg[0];
          obs[offset + 1] = pg[1];
          obs[offset + 2] = pg[2];
          break;
        }

        case "joint_pos": {
          const qOff = cfg.qpos_joint_offset;
          for (let i = 0; i < dim; i++) {
            obs[offset + i] =
              data.qpos[qOff + i] - cfg.default_joint_pos[i];
          }
          break;
        }

        case "joint_vel": {
          const vOff = cfg.qvel_joint_offset;
          for (let i = 0; i < dim; i++) {
            obs[offset + i] = data.qvel[vOff + i];
          }
          break;
        }

        case "actions": {
          for (let i = 0; i < dim; i++) {
            obs[offset + i] = this.lastAction[i];
          }
          break;
        }

        case "command": {
          obs[offset + 0] = this.command[0];
          obs[offset + 1] = this.command[1];
          obs[offset + 2] = this.command[2];
          break;
        }

        case "height_scan": {
          // Zero-filled (no ray casting in browser).
          break;
        }

        case "ee_to_cube": {
          this._fillEeToCube(obs, offset, data, cfg);
          break;
        }

        case "cube_to_goal": {
          this._fillCubeToGoal(obs, offset, data, cfg);
          break;
        }

        default:
          console.warn(`Unknown observation term: ${term}`);
          break;
      }

      // Always advance offset by the declared dim, even for unknown terms
      // (they'll be zero-filled).
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
    for (let i = 0; i < nAct; i++) {
      this.lastAction[i] = actionData[i];
    }
    for (let i = 0; i < nAct; i++) {
      const ctrlIdx = ctrlMap ? ctrlMap[i] : i;
      data.ctrl[ctrlIdx] =
        actionData[i] * cfg.action_scale[i] + actDefault[i];
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
      if (cfg.type !== "lifting") continue;

      this._liftingCfg = cfg;
      this._resampleManipulationCommand();

      // Periodically resample target + object position.
      const range = cfg.resampling_time_range || [8, 12];
      const intervalMs = _sampleUniform(range[0], range[1]) * 1000;
      this._commandResampleTimer = setInterval(() => {
        this._resampleManipulationCommand();
      }, intervalMs);
      break; // Only one lifting command expected.
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

  // ── Goal marker visualization ────────────────────────

  _initGoalMarker() {
    const scene = this.viewer.getScene();
    if (!scene || !this.commandTarget) return;

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

  _updateGoalMarker() {
    if (!this._goalMarker || !this.commandTarget) return;
    // Convert MuJoCo (Z-up) to Three.js (Y-up).
    const [mx, my, mz] = this.commandTarget;
    this._goalMarker.position.set(mx, mz, -my);
  }

  // ── Hardware constraint checking ──────────────────────

  /**
   * Set the DOM element for the constraint violation indicator.
   * @param {HTMLElement} el
   */
  setConstraintIndicator(el) {
    this._constraintEl = el;
  }

  /**
   * Check hardware constraints and update the indicator.
   * Uses position-dependent velocity limits from the Franka datasheet.
   */
  checkConstraints() {
    const hw = this.config.hardware_limits;
    if (!hw) return;

    const data = this.viewer.getData();
    const cfg = this.config;
    const qOff = cfg.qpos_joint_offset;
    const vOff = cfg.qvel_joint_offset;
    const dt = cfg.timestep * cfg.decimation;
    const n = hw.arm_joint_indices.length;

    const violations = [];

    for (let j = 0; j < n; j++) {
      const idx = hw.arm_joint_indices[j];
      const q = data.qpos[qOff + idx];
      const qd = data.qvel[vOff + idx];

      // Position limits.
      if (q > hw.q_max[j] || q < hw.q_min[j]) {
        violations.push({
          joint: j + 1,
          type: "pos",
          val: q,
          lo: hw.q_min[j],
          hi: hw.q_max[j],
        });
      }

      // Position-dependent velocity limits.
      const velUpper = Math.min(
        hw.q_dot_max[j],
        Math.max(
          0,
          -hw.q_dot_offset[j] +
            Math.sqrt(
              Math.max(0, 2 * hw.q_ddot_dec[j] * (hw.q_max[j] - q)),
            ),
        ),
      );
      const velLower = Math.max(
        -hw.q_dot_max[j],
        Math.min(
          0,
          hw.q_dot_offset[j] -
            Math.sqrt(
              Math.max(0, 2 * hw.q_ddot_dec[j] * (-hw.q_min[j] + q)),
            ),
        ),
      );
      if (qd > velUpper || qd < velLower) {
        violations.push({
          joint: j + 1,
          type: "vel",
          val: qd,
          lo: velLower,
          hi: velUpper,
        });
      }

      // Acceleration limits.
      if (this._prevArmVel) {
        const accel = (qd - this._prevArmVel[j]) / dt;
        if (Math.abs(accel) > hw.q_ddot_max[j]) {
          violations.push({
            joint: j + 1,
            type: "acc",
            val: accel,
            limit: hw.q_ddot_max[j],
          });
        }
      }
    }

    // Store current velocities for next step.
    if (!this._prevArmVel) this._prevArmVel = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const idx = hw.arm_joint_indices[j];
      this._prevArmVel[j] = data.qvel[vOff + idx];
    }

    this._constraintViolations = violations;
    this._updateConstraintIndicator(violations);
  }

  _updateConstraintIndicator(violations) {
    const el = this._constraintEl;
    if (!el) return;

    if (violations.length === 0) {
      el.className = "constraint-ok";
      el.innerHTML = "HW Limits: <b>OK</b>";
      return;
    }

    el.className = "constraint-violation";
    // Show the worst violations (up to 3).
    const lines = violations.slice(0, 3).map((v) => {
      if (v.type === "pos") {
        return `J${v.joint} pos ${v.val.toFixed(2)} ∉ [${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]`;
      } else if (v.type === "vel") {
        return `J${v.joint} vel ${v.val.toFixed(2)} ∉ [${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]`;
      } else {
        return `J${v.joint} acc ${v.val.toFixed(1)} > ${v.limit.toFixed(1)}`;
      }
    });
    if (violations.length > 3) {
      lines.push(`+${violations.length - 3} more`);
    }
    el.innerHTML =
      `HW Limits: <b>${violations.length} violation${violations.length > 1 ? "s" : ""}</b><br>` +
      lines.join("<br>");
  }

  // ── Phase plot visualization ──────────────────────

  /**
   * Initialize real-time position-velocity phase plots.
   * Draws FCI limit curves with current joint state as a moving dot.
   * @param {HTMLCanvasElement} canvas
   */
  initPhasePlots(canvas) {
    const hw = this.config.hardware_limits;
    if (!hw) return;

    this._phaseCanvas = canvas;
    this._phaseCtx = canvas.getContext("2d");

    // Handle high-DPI displays.
    const dpr = window.devicePixelRatio || 1;
    const logW = canvas.clientWidth;
    const logH = canvas.clientHeight;
    canvas.width = logW * dpr;
    canvas.height = logH * dpr;
    this._phaseCtx.scale(dpr, dpr);
    this._phaseLogW = logW;
    this._phaseLogH = logH;

    // Trail buffer for each joint.
    const n = hw.arm_joint_indices.length;
    const TRAIL_LEN = 80;
    this._phaseTrail = Array.from({ length: n }, () => ({
      q: new Float32Array(TRAIL_LEN),
      qd: new Float32Array(TRAIL_LEN),
      idx: 0,
      len: 0,
    }));
    this._phaseTrailMax = TRAIL_LEN;

    // Layout constants.
    this._phaseCols = 4;
    this._phasePad = { t: 16, r: 6, b: 8, l: 28 };

    this._precomputePhaseCurves();
    this._renderStaticPhasePlots();
  }

  _precomputePhaseCurves() {
    const hw = this.config.hardware_limits;
    const n = hw.arm_joint_indices.length;
    const nPts = 150;
    this._phaseCurves = [];

    for (let j = 0; j < n; j++) {
      const qMin = hw.q_min[j];
      const qMax = hw.q_max[j];
      const qdMax = hw.q_dot_max[j];
      const qdOff = hw.q_dot_offset[j];
      const qddDec = hw.q_ddot_dec[j];
      const upper = [];
      const lower = [];

      for (let k = 0; k <= nPts; k++) {
        const q = qMin + ((qMax - qMin) * k) / nPts;
        upper.push({
          q,
          qd: Math.min(
            qdMax,
            Math.max(
              0,
              -qdOff +
                Math.sqrt(Math.max(0, 2 * qddDec * (qMax - q))),
            ),
          ),
        });
        lower.push({
          q,
          qd: Math.max(
            -qdMax,
            Math.min(
              0,
              qdOff -
                Math.sqrt(Math.max(0, 2 * qddDec * (-qMin + q))),
            ),
          ),
        });
      }

      this._phaseCurves.push({
        qMin,
        qMax,
        qdMax,
        qdOff,
        qddDec,
        upper,
        lower,
      });
    }
  }

  /** Render static elements (curves, axes, labels) to an offscreen canvas. */
  _renderStaticPhasePlots() {
    const offscreen = document.createElement("canvas");
    offscreen.width = this._phaseCanvas.width;
    offscreen.height = this._phaseCanvas.height;
    const ctx = offscreen.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);

    const W = this._phaseLogW;
    const H = this._phaseLogH;
    const cols = this._phaseCols;
    const cellW = W / cols;
    const cellH = H / 2;
    const pad = this._phasePad;

    for (let j = 0; j < this._phaseCurves.length; j++) {
      const col = j % cols;
      const row = Math.floor(j / cols);
      const cx = col * cellW;
      const cy = row * cellH;
      const pw = cellW - pad.l - pad.r;
      const ph = cellH - pad.t - pad.b;
      const px0 = cx + pad.l;
      const py0 = cy + pad.t;
      const c = this._phaseCurves[j];

      const mapX = (q) =>
        px0 + ((q - c.qMin) / (c.qMax - c.qMin)) * pw;
      const mapY = (qd) =>
        py0 + ph - ((qd + c.qdMax) / (2 * c.qdMax)) * ph;

      // Cell background.
      ctx.fillStyle = "rgba(20,20,30,0.7)";
      ctx.fillRect(px0, py0, pw, ph);

      // Safe region fill.
      ctx.beginPath();
      for (let k = 0; k < c.upper.length; k++) {
        const x = mapX(c.upper[k].q);
        const y = mapY(c.upper[k].qd);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let k = c.lower.length - 1; k >= 0; k--) {
        ctx.lineTo(mapX(c.lower[k].q), mapY(c.lower[k].qd));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(0,180,80,0.1)";
      ctx.fill();

      // Upper limit curve.
      ctx.beginPath();
      for (let k = 0; k < c.upper.length; k++) {
        const x = mapX(c.upper[k].q);
        const y = mapY(c.upper[k].qd);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#ff5555";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Lower limit curve.
      ctx.beginPath();
      for (let k = 0; k < c.lower.length; k++) {
        const x = mapX(c.lower[k].q);
        const y = mapY(c.lower[k].qd);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#5588ff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Zero velocity line.
      ctx.beginPath();
      ctx.moveTo(px0, mapY(0));
      ctx.lineTo(px0 + pw, mapY(0));
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Joint label.
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`J${j + 1}`, px0 + pw / 2, cy + 12);

      // Y-axis labels (velocity range).
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "8px monospace";
      ctx.textAlign = "right";
      ctx.fillText(`${c.qdMax.toFixed(1)}`, px0 - 3, py0 + 7);
      ctx.fillText(`${(-c.qdMax).toFixed(1)}`, px0 - 3, py0 + ph);
    }

    this._phaseStaticImg = offscreen;
  }

  /** Update phase plots with current joint state. Called each frame. */
  updatePhasePlots() {
    if (!this._phaseStaticImg || !this._phaseCurves) return;

    const ctx = this._phaseCtx;
    const hw = this.config.hardware_limits;
    const data = this.viewer.getData();
    const cfg = this.config;
    const n = hw.arm_joint_indices.length;
    const W = this._phaseLogW;
    const cols = this._phaseCols;
    const cellW = W / cols;
    const cellH = this._phaseLogH / 2;
    const pad = this._phasePad;

    // Blit static background (curves, labels).
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._phaseStaticImg, 0, 0);
    ctx.restore();

    for (let j = 0; j < n; j++) {
      const col = j % cols;
      const row = Math.floor(j / cols);
      const px0 = col * cellW + pad.l;
      const py0 = row * cellH + pad.t;
      const pw = cellW - pad.l - pad.r;
      const ph = cellH - pad.t - pad.b;
      const c = this._phaseCurves[j];

      const mapX = (q) =>
        px0 + ((q - c.qMin) / (c.qMax - c.qMin)) * pw;
      const mapY = (qd) =>
        py0 + ph - ((qd + c.qdMax) / (2 * c.qdMax)) * ph;

      // Read current state.
      const idx = hw.arm_joint_indices[j];
      const q = data.qpos[cfg.qpos_joint_offset + idx];
      const qd = data.qvel[cfg.qvel_joint_offset + idx];

      // Update trail.
      const trail = this._phaseTrail[j];
      trail.q[trail.idx] = q;
      trail.qd[trail.idx] = qd;
      trail.idx = (trail.idx + 1) % this._phaseTrailMax;
      trail.len = Math.min(trail.len + 1, this._phaseTrailMax);

      // Draw trail as a fading line.
      if (trail.len > 1) {
        ctx.beginPath();
        for (let t = 0; t < trail.len; t++) {
          const ti =
            (trail.idx - trail.len + t + this._phaseTrailMax) %
            this._phaseTrailMax;
          const tx = mapX(
            Math.max(c.qMin, Math.min(c.qMax, trail.q[ti])),
          );
          const ty = mapY(
            Math.max(-c.qdMax, Math.min(c.qdMax, trail.qd[ti])),
          );
          t === 0 ? ctx.moveTo(tx, ty) : ctx.lineTo(tx, ty);
        }
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Check violation at current position.
      const velUp = Math.min(
        c.qdMax,
        Math.max(
          0,
          -c.qdOff +
            Math.sqrt(Math.max(0, 2 * c.qddDec * (c.qMax - q))),
        ),
      );
      const velLo = Math.max(
        -c.qdMax,
        Math.min(
          0,
          c.qdOff -
            Math.sqrt(Math.max(0, 2 * c.qddDec * (-c.qMin + q))),
        ),
      );
      const violating =
        q < c.qMin || q > c.qMax || qd > velUp || qd < velLo;

      const dotX = mapX(Math.max(c.qMin, Math.min(c.qMax, q)));
      const dotY = mapY(Math.max(-c.qdMax, Math.min(c.qdMax, qd)));

      // Glow.
      ctx.beginPath();
      ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
      ctx.fillStyle = violating
        ? "rgba(255,50,50,0.3)"
        : "rgba(50,255,100,0.3)";
      ctx.fill();

      // Dot.
      ctx.beginPath();
      ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
      ctx.fillStyle = violating ? "#ff3333" : "#33ff66";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
