
import React, { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { BreathPhase, ColorTheme, QualityTier } from "../types";

type Props = {
  phase: BreathPhase;
  theme: ColorTheme;
  quality: QualityTier;
  reduceMotion: boolean;
  isActive: boolean;
  progressRef: React.MutableRefObject<number>;
  entropyRef?: React.MutableRefObject<number>; // New: System Entropy Input
};

// ----- Palette: "Sắc Pháp" (The Colors of Dharma) -----
const THEMES = {
  warm: {
    bgHigh: new THREE.Color("#1a0b00"), 
    bgLow: new THREE.Color("#000000"),
    core: new THREE.Color("#ff9f43"),
    shell: new THREE.Color("#ff6b6b"), 
    accent: new THREE.Color("#feca57"),
    glow: new THREE.Color("#ff7675")
  },
  cool: {
    bgHigh: new THREE.Color("#001e1d"),
    bgLow: new THREE.Color("#000000"),
    core: new THREE.Color("#00d2d3"),
    shell: new THREE.Color("#2e86de"),
    accent: new THREE.Color("#48dbfb"),
    glow: new THREE.Color("#0abde3")
  },
  neutral: {
    bgHigh: new THREE.Color("#0d0d12"),
    bgLow: new THREE.Color("#000000"),
    core: new THREE.Color("#c8d6e5"),
    shell: new THREE.Color("#8395a7"),
    accent: new THREE.Color("#ffffff"),
    glow: new THREE.Color("#a4b0be")
  },
} as const;

function resolveTier(q: QualityTier) {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const isLow = q === "low";
  return { 
    dpr: isLow ? Math.min(dpr, 1) : Math.min(dpr, 1.5), 
    geoSeg: isLow ? 64 : 128, 
    particles: isLow ? 30 : 150
  };
}

// --- NOISE CHUNK (Included in shaders) ---
const NOISE_CHUNK = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 = v - i + dot(i, C.xxx) ;
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
}

float fbm(vec3 x) {
  float v = 0.0;
  float a = 0.5;
  vec3 shift = vec3(100.0);
  for (int i = 0; i < 3; ++i) {
    v += a * snoise(x);
    x = x * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}
`;

const VOID_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;
const VOID_FRAG = `
varying vec2 vUv;
uniform vec3 uColorHigh;
uniform vec3 uColorLow;
uniform float uTime;
uniform float uIntensity;
uniform float uEntropy; // CHAOS METRIC

${NOISE_CHUNK}

void main() {
  vec2 uv = vUv;
  float t = uTime * 0.05;
  
  // Entropy distorts the background flow
  vec2 distortion = vec2(snoise(vec3(uv * 5.0, t)), snoise(vec3(uv * 5.0 + 10.0, t))) * uEntropy * 0.1;
  uv += distortion;

  float flow1 = snoise(vec3(uv * 1.8 + vec2(0, t), t));
  float flow2 = snoise(vec3(uv * 3.5 - vec2(t*0.5, 0), t * 1.5));
  float nebula = (flow1 + flow2 * 0.6) * 0.5;
  
  float dist = length(vUv - 0.5);
  float vignette = smoothstep(0.9, 0.2, dist);
  float breathGlow = uIntensity * 0.15;
  
  // High entropy shifts background slightly red/grey (Stress)
  vec3 baseColorLow = mix(uColorLow, vec3(0.05, 0.0, 0.0), uEntropy * 0.5);
  vec3 baseColorHigh = mix(uColorHigh, vec3(0.1, 0.1, 0.1), uEntropy * 0.8);

  vec3 bg = mix(baseColorLow, baseColorHigh, vignette * (0.3 + breathGlow));
  
  float starNoise = pow(max(0.0, snoise(vec3(uv * 20.0, uTime * 0.1))), 8.0);
  bg += starNoise * 0.05;

  vec3 cloudColor = mix(baseColorLow, baseColorHigh * 1.2, smoothstep(-0.2, 0.6, nebula));
  vec3 final = mix(bg, cloudColor, 0.2);

  // Entropy Noise (Digital Grain)
  float noise = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
  final += (noise - 0.5) * (0.01 + uEntropy * 0.05);

  gl_FragColor = vec4(final, 1.0);
}
`;

const PEARL_VERT = `
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vWorldPos;
varying float vNoise;

uniform float uTime;
uniform float uExpand;     
uniform float uTurbulence; 
uniform float uRoughness;
uniform float uEntropy; // CHAOS METRIC

${NOISE_CHUNK}

void main() {
  vec3 p = position;
  
  // Entropy affects roughness directly
  float currentRoughness = uRoughness + (uEntropy * 2.0); 
  float currentTurbulence = uTurbulence + (uEntropy * 0.2); // Significant distortion on high entropy

  float n = fbm(p * (1.5 + currentRoughness) + vec3(0.0, uTime * (0.2 + uEntropy), 0.0));
  float d = snoise(p * 3.0 - uTime * 0.3);
  
  float combined = (n + d * 0.2) * currentTurbulence; 
  vNoise = combined;

  // Glitch effect on high entropy
  if (uEntropy > 0.6) {
     float glitch = step(0.98, sin(uTime * 20.0 + p.y * 10.0));
     p += normal * glitch * 0.1;
  }

  vec3 newPos = p + normal * (combined * 0.5 + uExpand * 0.25);

  vec4 mvPosition = modelViewMatrix * vec4(newPos, 1.0);
  vWorldPos = (modelMatrix * vec4(newPos, 1.0)).xyz;
  vViewPosition = -mvPosition.xyz;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const PEARL_FRAG = `
varying vec3 vNormal;
varying vec3 vViewPosition;
varying float vNoise;
varying vec3 vWorldPos;

uniform vec3 uCoreColor;
uniform vec3 uShellColor;
uniform vec3 uAccentColor;
uniform vec3 uGlowColor;
uniform float uOpacity;
uniform float uIntensity;
uniform float uEntropy; // CHAOS METRIC

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewPosition);
  
  float fresnelBase = dot(normal, viewDir);
  float fresnel = pow(1.0 - abs(fresnelBase), 3.0);
  
  vec3 iridescence;
  iridescence.r = pow(1.0 - abs(fresnelBase * 0.98), 4.0);
  iridescence.g = pow(1.0 - abs(fresnelBase * 1.00), 4.0);
  iridescence.b = pow(1.0 - abs(fresnelBase * 1.02), 4.0);
  
  float depth = smoothstep(-0.2, 0.4, vNoise * 2.0);
  
  // High Entropy desaturates colors and adds "Sick" tint
  vec3 chaoticTint = vec3(1.0, 0.2, 0.2); // Red warning
  float chaosMix = smoothstep(0.3, 1.0, uEntropy);

  vec3 cCore = mix(uCoreColor, chaoticTint, chaosMix * 0.3);
  vec3 cShell = mix(uShellColor, vec3(0.1), chaosMix * 0.5); // Grey out shell

  vec3 col = mix(cShell, cCore, depth);
  col = mix(col, uGlowColor, uIntensity * 0.6 * depth);
  col += iridescence * uAccentColor * (0.8 + uIntensity * 0.4);
  
  float alpha = uOpacity * (0.15 + fresnel * 0.85);
  col *= (1.0 + uIntensity * 0.3);

  gl_FragColor = vec4(col, alpha);
}
`;

function InfiniteVoid({ colors, isActive, phase, entropyRef }: any) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const intensityRef = useRef(0);

  useFrame((state, dt) => {
    if (mat.current) {
        const target = (isActive && (phase === 'inhale' || phase === 'holdIn')) ? 1.0 : 0.0;
        intensityRef.current = THREE.MathUtils.lerp(intensityRef.current, target, dt * 0.5);

        mat.current.uniforms.uTime.value = state.clock.elapsedTime;
        mat.current.uniforms.uColorHigh.value.lerp(colors.bgHigh, 0.05);
        mat.current.uniforms.uColorLow.value.lerp(colors.bgLow, 0.05);
        mat.current.uniforms.uIntensity.value = intensityRef.current;
        mat.current.uniforms.uEntropy.value = entropyRef?.current || 0;
    }
  });

  return (
    <mesh position={[0, 0, -8]}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={mat}
        vertexShader={VOID_VERT}
        fragmentShader={VOID_FRAG}
        uniforms={{
          uColorHigh: { value: colors.bgHigh },
          uColorLow: { value: colors.bgLow },
          uIntensity: { value: 0 },
          uTime: { value: 0 },
          uEntropy: { value: 0 }
        }}
        depthWrite={false}
      />
    </mesh>
  );
}

function LuminousPearl({ phase, colors, isActive, progressRef, entropyRef, tier, reduceMotion }: any) {
  const mesh = useRef<THREE.Mesh>(null);
  const coreMesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.ShaderMaterial>(null);
  
  const stateRef = useRef({ intensity: 0, expand: 0, turbulence: 0.1 });

  useFrame((state, delta) => {
    const p = progressRef.current;
    const entropy = entropyRef?.current || 0;
    const t = state.clock.getElapsedTime();
    const s = stateRef.current;

    let targetIntensity = 0;
    let targetExpand = 0;
    let targetTurbulence = 0.02;

    if (!isActive) {
        const idle = Math.sin(t * 0.5) * 0.5 + 0.5;
        targetIntensity = idle * 0.1;
        targetExpand = idle * 0.05;
        targetTurbulence = 0.03 + (entropy * 0.1); // Restless if high entropy
    } else {
        if (phase === 'inhale') {
            targetIntensity = p;
            targetExpand = p * 1.5; 
            targetTurbulence = 0.05 + p * 0.05;
        } else if (phase === 'holdIn') {
            targetIntensity = 1.0;
            targetExpand = 1.5 + Math.sin(t * 4) * 0.015;
            targetTurbulence = 0.12;
        } else if (phase === 'exhale') {
            targetIntensity = 1.0 - p;
            targetExpand = (1.0 - p) * 1.5;
            targetTurbulence = 0.12 - p * 0.08;
        } else { 
            targetIntensity = 0.0;
            targetExpand = 0.0;
            targetTurbulence = 0.02;
        }
    }

    const speed = reduceMotion ? 1.0 : 2.5;
    const lerp = 1 - Math.exp(-speed * delta);
    
    s.intensity = THREE.MathUtils.lerp(s.intensity, targetIntensity, lerp);
    s.expand = THREE.MathUtils.lerp(s.expand, targetExpand, lerp);
    s.turbulence = THREE.MathUtils.lerp(s.turbulence, targetTurbulence, lerp);

    if (mat.current) {
        mat.current.uniforms.uTime.value = t;
        mat.current.uniforms.uIntensity.value = s.intensity;
        mat.current.uniforms.uExpand.value = s.expand;
        mat.current.uniforms.uTurbulence.value = s.turbulence;
        mat.current.uniforms.uEntropy.value = entropy; // Inject Chaos
        
        const cSpeed = 0.06;
        mat.current.uniforms.uCoreColor.value.lerp(colors.core, cSpeed);
        mat.current.uniforms.uShellColor.value.lerp(colors.shell, cSpeed);
        mat.current.uniforms.uAccentColor.value.lerp(colors.accent, cSpeed);
        mat.current.uniforms.uGlowColor.value.lerp(colors.glow, cSpeed);
    }

    if (coreMesh.current) {
        const coreScale = 0.4 + s.intensity * 0.3 - (entropy * 0.1); // Core shrinks in chaos
        coreMesh.current.scale.setScalar(coreScale);
    }

    if (mesh.current && !reduceMotion) {
        mesh.current.rotation.y = t * 0.05;
        // Jitter rotation on high entropy
        mesh.current.rotation.z = Math.sin(t * 0.15) * 0.05 + (Math.random() - 0.5) * entropy * 0.1;
    }
  });

  return (
    <group>
      <mesh ref={coreMesh}>
         <sphereGeometry args={[1, 32, 32]} />
         <meshBasicMaterial 
            color={colors.core} 
            transparent 
            opacity={0.8} 
            blending={THREE.AdditiveBlending} 
         />
      </mesh>
      <mesh ref={mesh}>
        <sphereGeometry args={[1.2, tier.geoSeg, tier.geoSeg]} />
        <shaderMaterial
          ref={mat}
          vertexShader={PEARL_VERT}
          fragmentShader={PEARL_FRAG}
          uniforms={{
            uTime: { value: 0 },
            uExpand: { value: 0 },
            uTurbulence: { value: 0.02 },
            uRoughness: { value: 0.8 },
            uIntensity: { value: 0 },
            uEntropy: { value: 0 },
            uCoreColor: { value: colors.core },
            uShellColor: { value: colors.shell },
            uAccentColor: { value: colors.accent },
            uGlowColor: { value: colors.glow },
            uOpacity: { value: 0.8 }
          }}
          transparent={true}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function Stardust({ count, color, isActive, entropyRef }: any) {
    const points = useRef<THREE.Points>(null);
    const [pos, randoms] = useMemo(() => {
        const p = new Float32Array(count * 3);
        const r = new Float32Array(count * 3);
        for(let i=0; i<count; i++) {
            const rad = 2.8 + Math.random() * 2.5;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            p[i*3] = rad * Math.sin(phi) * Math.cos(theta);
            p[i*3+1] = rad * Math.cos(phi);
            p[i*3+2] = rad * Math.sin(phi) * Math.sin(theta);
            r[i*3] = (Math.random() - 0.5) * 0.01;
            r[i*3+1] = (Math.random() - 0.5) * 0.01;
            r[i*3+2] = Math.random();
        }
        return [p, r];
    }, [count]);

    useFrame((state) => {
        if (!points.current) return;
        const t = state.clock.getElapsedTime();
        const entropy = entropyRef?.current || 0;
        
        const baseOpacity = isActive ? 0.5 : 0.15;
        const positions = points.current.geometry.attributes.position.array as Float32Array;
        
        for(let i=0; i<count; i++) {
             const x = pos[i*3];
             const z = pos[i*3+2];
             // High entropy = Erratic orbits
             const speedMult = 1.0 + entropy * 5.0;
             const angle = t * 0.05 * speedMult + randoms[i*3+2];
             
             const rx = x * Math.cos(angle) - z * Math.sin(angle);
             const rz = x * Math.sin(angle) + z * Math.cos(angle);
             
             positions[i*3] = rx;
             positions[i*3+1] = pos[i*3+1] + Math.sin(t + i) * 0.1;
             positions[i*3+2] = rz;
        }
        points.current.geometry.attributes.position.needsUpdate = true;
        
        const scale = isActive ? 1.0 + Math.sin(t) * 0.1 : 1.0;
        points.current.scale.setScalar(scale);
        
        (points.current.material as THREE.PointsMaterial).opacity = baseOpacity * (1.0 - entropy * 0.5); // Fade out in chaos
        (points.current.material as THREE.PointsMaterial).color.lerp(color, 0.05);
    });

    return (
        <points ref={points}>
            <bufferGeometry>
                <bufferAttribute attach="attributes-position" count={count} array={pos} itemSize={3} />
            </bufferGeometry>
            <pointsMaterial 
                size={0.06} 
                color={color} 
                transparent 
                opacity={0.3} 
                blending={THREE.AdditiveBlending}
                sizeAttenuation 
                depthWrite={false}
                map={getGlowSprite()}
            />
        </points>
    );
}

let _glowSprite: THREE.Texture;
function getGlowSprite() {
    if (_glowSprite) return _glowSprite;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (context) {
        const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.5, 'rgba(255,255,255,0.2)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 32, 32);
    }
    _glowSprite = new THREE.CanvasTexture(canvas);
    return _glowSprite;
}

export default function OrbBreathViz(props: Props) {
  const tier = useMemo(() => resolveTier(props.quality), [props.quality]);
  const colors = useMemo(() => THEMES[props.theme] ?? THEMES.neutral, [props.theme]);

  return (
    <Canvas 
      dpr={tier.dpr} 
      camera={{ position: [0, 0, 6], fov: 35 }} 
      gl={{ 
        antialias: true, 
        alpha: false,
        powerPreference: "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.2,
      }}
      className="transition-opacity duration-1000 ease-in-out"
    >
      <InfiniteVoid colors={colors} isActive={props.isActive} phase={props.phase} entropyRef={props.entropyRef} />
      <LuminousPearl {...props} colors={colors} tier={tier} />
      <Stardust count={tier.particles} color={colors.accent} isActive={props.isActive} entropyRef={props.entropyRef} />
    </Canvas>
  );
}
