/**
 * Three.js geometry builders for MuJoCo models.
 *
 * Handles coordinate frame conversion: MuJoCo uses Z-up,
 * Three.js uses Y-up. All helpers apply this swizzle.
 *
 * Adapted from the proven tune-to-learn viewer implementation.
 */

import * as THREE from "three";

/** MuJoCo Z-up → Three.js Y-up position. */
export function getPosition(buf, i, target) {
  return target.set(buf[i * 3], buf[i * 3 + 2], -buf[i * 3 + 1]);
}

/** MuJoCo Z-up → Three.js Y-up quaternion. */
export function getQuaternion(buf, i, target) {
  // MuJoCo quat: [w, x, y, z] at indices 0,1,2,3.
  // Three.js Quaternion.set(x, y, z, w).
  return target.set(
    -buf[i * 4 + 1],
    -buf[i * 4 + 3],
    buf[i * 4 + 2],
    -buf[i * 4 + 0],
  );
}

/**
 * Build Three.js body groups from MuJoCo model geoms.
 *
 * Each geom is placed inside a body group with its local
 * geom_pos/geom_quat offset applied. Returns {bodies, meshes, root}.
 *
 * @param {object} model - MuJoCo MjModel.
 * @returns {{root: THREE.Group, bodies: Object, meshes: THREE.Mesh[]}}
 */
export function buildBodies(model) {
  const bodies = {};
  const meshes = [];
  const meshGeometries = {};

  for (let g = 0; g < model.ngeom; g++) {
    if (!(model.geom_group[g] < 3)) continue;

    const b = model.geom_bodyid[g];
    const type = model.geom_type[g];
    const size = [
      model.geom_size[g * 3 + 0],
      model.geom_size[g * 3 + 1],
      model.geom_size[g * 3 + 2],
    ];

    if (!(b in bodies)) {
      bodies[b] = new THREE.Group();
      bodies[b].bodyID = b;
    }

    let geometry;

    if (type === 0) {
      // Plane — skip (we render our own ground).
      continue;
    } else if (type === 2) {
      geometry = new THREE.SphereGeometry(size[0]);
    } else if (type === 3) {
      geometry = new THREE.CapsuleGeometry(size[0], size[1] * 2, 20, 20);
    } else if (type === 5) {
      geometry = new THREE.CylinderGeometry(size[0], size[0], size[1] * 2);
    } else if (type === 6) {
      // Box: swap Y/Z for coordinate conversion.
      geometry = new THREE.BoxGeometry(
        size[0] * 2,
        size[2] * 2,
        size[1] * 2,
      );
    } else if (type === 7) {
      const meshID = model.geom_dataid[g];
      if (meshID < 0) continue;
      if (!(meshID in meshGeometries)) {
        geometry = new THREE.BufferGeometry();

        // Vertices with Y↔Z swizzle.
        const vertBuf = new Float32Array(
          model.mesh_vert.subarray(
            model.mesh_vertadr[meshID] * 3,
            (model.mesh_vertadr[meshID] + model.mesh_vertnum[meshID]) * 3,
          ),
        );
        for (let v = 0; v < vertBuf.length; v += 3) {
          const tmp = vertBuf[v + 1];
          vertBuf[v + 1] = vertBuf[v + 2];
          vertBuf[v + 2] = -tmp;
        }

        // Normals with Y↔Z swizzle.
        let normBuf;
        if (model.mesh_normaladr && model.mesh_normalnum) {
          normBuf = new Float32Array(
            model.mesh_normal.subarray(
              model.mesh_normaladr[meshID] * 3,
              (model.mesh_normaladr[meshID] + model.mesh_normalnum[meshID]) *
                3,
            ),
          );
          for (let v = 0; v < normBuf.length; v += 3) {
            const tmp = normBuf[v + 1];
            normBuf[v + 1] = normBuf[v + 2];
            normBuf[v + 2] = -tmp;
          }
        }

        // Faces.
        const faceBuf = new Int32Array(
          model.mesh_face.subarray(
            model.mesh_faceadr[meshID] * 3,
            (model.mesh_faceadr[meshID] + model.mesh_facenum[meshID]) * 3,
          ),
        );

        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(vertBuf, 3),
        );
        if (normBuf && normBuf.length === vertBuf.length) {
          geometry.setAttribute(
            "normal",
            new THREE.BufferAttribute(normBuf, 3),
          );
        }
        geometry.setIndex(Array.from(faceBuf));
        geometry.computeVertexNormals();
        meshGeometries[meshID] = geometry;
      } else {
        geometry = meshGeometries[meshID].clone();
      }
    } else {
      continue;
    }

    // Color from material or geom rgba.
    let color;
    if (model.geom_matid[g] !== -1) {
      const matId = model.geom_matid[g];
      color = [
        model.mat_rgba[matId * 4],
        model.mat_rgba[matId * 4 + 1],
        model.mat_rgba[matId * 4 + 2],
        model.mat_rgba[matId * 4 + 3],
      ];
    } else {
      color = [
        model.geom_rgba[g * 4],
        model.geom_rgba[g * 4 + 1],
        model.geom_rgba[g * 4 + 2],
        model.geom_rgba[g * 4 + 3],
      ];
    }

    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color[0], color[1], color[2]),
      transparent: color[3] < 1.0,
      opacity: color[3],
      roughness: 0.45,
      metalness: 0.1,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.bodyID = b;
    bodies[b].add(mesh);
    meshes.push(mesh);

    // Apply geom-local transform (Z-up → Y-up).
    getPosition(model.geom_pos, g, mesh.position);
    getQuaternion(model.geom_quat, g, mesh.quaternion);
  }

  // Ensure all bodies exist.
  for (let b = 0; b < model.nbody; b++) {
    if (!(b in bodies)) {
      bodies[b] = new THREE.Group();
      bodies[b].bodyID = b;
    }
  }

  // Build hierarchy: all bodies are children of body 0 (world).
  const root = new THREE.Group();
  root.name = "MuJoCo Root";
  for (let b = 0; b < model.nbody; b++) {
    if (b === 0) root.add(bodies[b]);
    else bodies[0].add(bodies[b]);
  }

  return { root, bodies, meshes };
}

/**
 * Sync Three.js body transforms from MuJoCo simulation data.
 *
 * @param {object} model - MuJoCo MjModel.
 * @param {object} data - MuJoCo MjData.
 * @param {Object} bodies - Body index → Three.js group.
 */
export function syncBodies(model, data, bodies) {
  for (let b = 0; b < model.nbody; b++) {
    if (!(b in bodies)) continue;
    getPosition(data.xpos, b, bodies[b].position);
    getQuaternion(data.xquat, b, bodies[b].quaternion);
  }
}

/**
 * Rotate a vector by the inverse (conjugate) of a quaternion.
 * Used for projected gravity computation.
 *
 * @param {number[]} v - 3D vector [x, y, z].
 * @param {number[]} q - Quaternion [w, x, y, z].
 * @returns {Float32Array} Rotated vector.
 */
export function rotateVectorByQuatInverse(v, q) {
  const qw = q[0],
    qx = -q[1],
    qy = -q[2],
    qz = -q[3];
  const vx = v[0],
    vy = v[1],
    vz = v[2];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return new Float32Array([
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ]);
}
