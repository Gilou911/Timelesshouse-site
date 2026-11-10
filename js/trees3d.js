// Arbres isolés en 3D : une couche WebGL de MapLibre (rendu « 3d », profondeur partagée avec les bâtiments) qui dessine
// chaque arbre d'un seul tenant, à la manière de Shadowmap : un houppier rond et lisse, éclairé par le soleil, sur un
// tronc. Le houppier est l'ellipsoïde de treeShape, celui-là même qui porte l'ombre : ce qu'on voit est ce qui ombrage.
import { lngLatToMercator } from './shadow-engine.js';
import { treeShape } from './trees.js';

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
export const STRIDE = 7; // par arbre : dx, dy, base, r, rv, cz (unités Mercator), teinte
const CROWN = [0.42, 0.62, 0.33]; // vert du houppier (clair au soleil, plus sombre à l'ombre propre)
const CROWN_SATELLITE = [0.36, 0.55, 0.29];
const TRUNK = [0.46, 0.38, 0.3];
// Loin (houppiers de quelques pixels), une sphère plus simple : à 20 000 arbres, deux fois moins de triangles.
const DETAIL_ZOOM = 16.5;

/** Sphère unité (pôles sur z), en triangles : la position d'un sommet est aussi sa normale. */
export function sphereMesh(segments = 14, rings = 9) {
  const v = [];
  const at = (i, j) => {
    const lat = -Math.PI / 2 + (Math.PI * i) / rings;
    const lng = (2 * Math.PI * j) / segments;
    return [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = at(i, j);
      const b = at(i, j + 1);
      const c = at(i + 1, j + 1);
      const d = at(i + 1, j);
      v.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  return new Float32Array(v);
}

/** Cylindre unité (rayon 1, de z = 0 à z = 1), sans fonds, en triangles. */
export function cylinderMesh(segments = 6) {
  const v = [];
  for (let j = 0; j < segments; j++) {
    const a0 = (2 * Math.PI * j) / segments;
    const a1 = (2 * Math.PI * (j + 1)) / segments;
    const p = (a, z) => [Math.cos(a), Math.sin(a), z];
    v.push(...p(a0, 0), ...p(a1, 0), ...p(a1, 1), ...p(a0, 0), ...p(a1, 1), ...p(a0, 1));
  }
  return new Float32Array(v);
}

/** Unités Mercator par mètre à cette latitude. */
export const mercatorPerMeter = (lat) => 1 / (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180));

/**
 * Données des arbres pour le GPU, à plat : décalage Mercator depuis `origin` (dx, dy), sol au pied (base), rayon et
 * demi-hauteur du houppier, hauteur de son centre (r, rv, cz), tout en unités Mercator (k par mètre), et une teinte
 * de ±6 %, tirée de la position, pour que les houppiers voisins ne soient pas tous du même vert.
 * `baseAt(lng, lat)` : altitude du sol (m) quand le relief 3D est affiché, sinon 0.
 */
export function treeInstances(trees, origin, k, baseAt = null) {
  const n = trees.length / 4;
  const out = new Float32Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    const lng = trees[4 * i];
    const lat = trees[4 * i + 1];
    const { h, r, hb } = treeShape(trees[4 * i + 2], trees[4 * i + 3]);
    const [x, y] = lngLatToMercator(lng, lat);
    const o = i * STRIDE;
    out[o] = x - origin[0];
    out[o + 1] = y - origin[1];
    out[o + 2] = (baseAt ? baseAt(lng, lat) || 0 : 0) * k;
    out[o + 3] = r * k;
    out[o + 4] = ((h - hb) / 2) * k;
    out[o + 5] = ((h + hb) / 2) * k;
    const s = Math.sin(lng * 12.9898 + lat * 78.233) * 43758.5453;
    out[o + 6] = (s - Math.floor(s) - 0.5) * 0.12;
  }
  return out;
}

/**
 * Lumière des arbres, comme celle des bâtiments (sunLight, map.js) : direction du soleil (est, nord, haut), part
 * ambiante et part directe. Du coucher à −6°, la lumière directe s'éteint et l'ambiante baisse.
 */
export function treeLight(azimuth, altitude) {
  const t = Math.min(1, Math.max(0, -altitude / 6));
  const a = (Math.max(0, altitude) * Math.PI) / 180;
  const z = (azimuth * Math.PI) / 180;
  return { dir: [Math.sin(z) * Math.cos(a), Math.cos(z) * Math.cos(a), Math.sin(a)], ambient: 0.6 - 0.25 * t, direct: altitude > 0 ? 0.5 : 0 };
}

const VS = `
precision highp float;
uniform mat4 u_matrix;
uniform float u_trunk;
uniform float u_k;
attribute vec3 a_pos;
attribute vec3 a_center;
attribute vec4 a_shape;
varying vec3 v_normal;
varying float v_tint;
void main() {
  vec3 p;
  if (u_trunk > 0.5) {
    float rt = clamp(0.08 * a_shape.x, 0.15 * u_k, 0.5 * u_k);
    p = vec3(a_pos.xy * rt, a_pos.z * (a_shape.z - 0.4 * a_shape.y));
    v_normal = vec3(a_pos.xy, 0.0);
  } else {
    p = vec3(a_pos.xy * a_shape.x, a_shape.z + a_pos.z * a_shape.y);
    v_normal = vec3(a_pos.xy, a_pos.z * a_shape.x / a_shape.y);
  }
  v_tint = a_shape.w;
  gl_Position = u_matrix * vec4(a_center.x + p.x, a_center.y - p.y, a_center.z + p.z, 1.0);
}`;

const FS = `
precision mediump float;
uniform vec3 u_color;
uniform vec3 u_light;
uniform vec2 u_shade;
varying vec3 v_normal;
varying float v_tint;
void main() {
  float d = max(dot(normalize(v_normal), u_light), 0.0);
  gl_FragColor = vec4(u_color * (u_shade.x + u_shade.y * d) * (1.0 + v_tint), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Arbres 3D : ${gl.getShaderInfoLog(s)}`);
  return s;
}

/** Instanciation et objets de sommets : natifs en WebGL 2, par extensions en WebGL 1 (null si absents). */
function instancing(gl) {
  if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
    return {
      divisor: (i, d) => gl.vertexAttribDivisor(i, d),
      draw: (count, n) => gl.drawArraysInstanced(gl.TRIANGLES, 0, count, n),
      createVAO: () => gl.createVertexArray(),
      bindVAO: (v) => gl.bindVertexArray(v),
      deleteVAO: (v) => gl.deleteVertexArray(v),
    };
  }
  const inst = gl.getExtension('ANGLE_instanced_arrays');
  const vao = gl.getExtension('OES_vertex_array_object');
  if (!inst || !vao) return null;
  return {
    divisor: (i, d) => inst.vertexAttribDivisorANGLE(i, d),
    draw: (count, n) => inst.drawArraysInstancedANGLE(gl.TRIANGLES, 0, count, n),
    createVAO: () => vao.createVertexArrayOES(),
    bindVAO: (v) => vao.bindVertexArrayOES(v),
    deleteVAO: (v) => vao.deleteVertexArrayOES(v),
  };
}

/**
 * Couche personnalisée de MapLibre. Les objets WebGL sont créés au premier rendu (MapLibre rétablit son propre état
 * juste après), recréés après un changement de fond de carte (onRemove puis onAdd).
 */
export class TreesLayer {
  constructor(id) {
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '3d';
    this.visible = true;
    this.satellite = false;
    this.count = 0;
    this.data = new Float32Array(0);
    this.light = treeLight(180, 45);
  }

  /** Arbres à plat [lng, lat, hauteur, diamètre, …] ; `baseAt` : altitude du sol avec le relief 3D. */
  setTrees(trees, baseAt = null) {
    this.trees = trees;
    this.count = trees.length / 4;
    if (this.count) {
      const lat = trees[1];
      this.origin = lngLatToMercator(trees[0], lat);
      this.k = mercatorPerMeter(lat);
      this.data = treeInstances(trees, this.origin, this.k, baseAt);
    } else {
      this.data = new Float32Array(0);
    }
    this.dirty = true;
    if (this.map) this.map.triggerRepaint();
  }

  /** Relief 3D affiché ou retiré : les pieds des arbres suivent le sol. */
  setBase(baseAt) {
    if (this.trees && this.count) this.setTrees(this.trees, baseAt);
  }

  setSun(azimuth, altitude) {
    this.light = treeLight(azimuth, altitude);
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.ready = false;
    this.dirty = true;
  }

  onRemove(map, gl) {
    if (this.ready && this.api) {
      for (const v of Object.values(this.vaos)) this.api.deleteVAO(v);
      for (const b of [...Object.values(this.meshBuffers), this.instanceBuffer]) gl.deleteBuffer(b);
      gl.deleteProgram(this.program);
    }
    this.ready = false;
  }

  _init(gl) {
    this.ready = true;
    this.api = instancing(gl);
    if (!this.api) return; // sans instanciation, pas d'arbres 3D (les ombres restent)
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Arbres 3D : ${gl.getProgramInfoLog(p)}`);
    this.program = p;
    this.loc = {};
    for (const u of ['u_matrix', 'u_trunk', 'u_k', 'u_color', 'u_light', 'u_shade']) this.loc[u] = gl.getUniformLocation(p, u);
    const attr = { pos: gl.getAttribLocation(p, 'a_pos'), center: gl.getAttribLocation(p, 'a_center'), shape: gl.getAttribLocation(p, 'a_shape') };
    const meshes = { crown: sphereMesh(), crownFar: sphereMesh(8, 5), trunk: cylinderMesh() };
    this.vertexCount = {};
    this.meshBuffers = {};
    this.instanceBuffer = gl.createBuffer();
    this.vaos = {};
    for (const part of Object.keys(meshes)) {
      this.vertexCount[part] = meshes[part].length / 3;
      const vao = this.api.createVAO();
      this.api.bindVAO(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, meshes[part], gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attr.pos);
      gl.vertexAttribPointer(attr.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.enableVertexAttribArray(attr.center);
      gl.vertexAttribPointer(attr.center, 3, gl.FLOAT, false, STRIDE * 4, 0);
      this.api.divisor(attr.center, 1);
      gl.enableVertexAttribArray(attr.shape);
      gl.vertexAttribPointer(attr.shape, 4, gl.FLOAT, false, STRIDE * 4, 12);
      this.api.divisor(attr.shape, 1);
      this.meshBuffers[part] = buf;
      this.vaos[part] = vao;
    }
    this.api.bindVAO(null);
  }

  render(gl, args) {
    if (!this.visible || !this.count) return;
    if (!this.ready) this._init(gl);
    if (!this.api) return;
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW);
      this.dirty = false;
    }
    // Matrice de la carte (Mercator 0..1) décalée sur l'origine des arbres, en double précision avant l'envoi : en
    // simple précision, une position Mercator absolue ne tient qu'à 2 m près.
    const m = Array.from(args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args.modelViewProjectionMatrix);
    const [ox, oy] = this.origin;
    for (let i = 0; i < 4; i++) m[12 + i] += m[i] * ox + m[4 + i] * oy;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.loc.u_matrix, false, new Float32Array(m));
    gl.uniform1f(this.loc.u_k, this.k);
    gl.uniform3fv(this.loc.u_light, this.light.dir);
    gl.uniform2f(this.loc.u_shade, this.light.ambient, this.light.direct);
    gl.disable(gl.CULL_FACE);
    for (const part of [this.map.getZoom() < DETAIL_ZOOM ? 'crownFar' : 'crown', 'trunk']) {
      gl.uniform1f(this.loc.u_trunk, part === 'trunk' ? 1 : 0);
      gl.uniform3fv(this.loc.u_color, part === 'trunk' ? TRUNK : this.satellite ? CROWN_SATELLITE : CROWN);
      this.api.bindVAO(this.vaos[part]);
      this.api.draw(this.vertexCount[part], this.count);
    }
    this.api.bindVAO(null);
  }
}
