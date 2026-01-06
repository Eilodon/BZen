
import * as Tone from 'tone';
import { SoundPack, CueType, Language } from '../types';
import { TRANSLATIONS } from '../translations';
import { useSettingsStore } from '../stores/settingsStore';

// -- AUDIO GRAPH STATE --
let isUnlocked = false;
let isSettingUp = false; // Mutex to prevent race conditions

/**
 * UTILITY: Safe Disposal
 * Prevents "Node is already disposed" or Native AudioContext errors during teardown.
 */
function safeDispose(node: Tone.ToneAudioNode | Tone.Param | null | undefined) {
  if (!node) return;
  try {
    // Check internal Tone.js 'disposed' flag if available
    if ('disposed' in node && (node as any).disposed) return;
    node.dispose();
  } catch (e) {
    // We intentionally swallow disposal errors because the node is likely already
    // garbage collected or detached by the native AudioContext.
  }
}

/**
 * 3.4 ADAPTIVE AUDIO MANAGER
 */
class AdaptiveAudioManager {
  getQuality(): 'low' | 'medium' | 'high' {
    const userSetting = useSettingsStore.getState().userSettings.quality;
    if (userSetting !== 'auto') return userSetting as 'low' | 'medium' | 'high';

    // Auto-detection
    if (typeof navigator === 'undefined') return 'medium';
    
    // @ts-ignore
    const connection = navigator.connection;
    // @ts-ignore
    const memory = navigator.deviceMemory;
    const cores = navigator.hardwareConcurrency || 2;

    // Conservative checks for low-end devices
    const isLowEnd = (memory && memory < 4) || cores < 4;
    const isSlowConnection = connection && (connection.saveData || ['slow-2g', '2g'].includes(connection.effectiveType));

    if (isSlowConnection || isLowEnd) {
      return 'low';
    } else if (cores < 8) {
      return 'medium';
    }
    return 'high';
  }

  getConfig() {
    const q = this.getQuality();
    switch (q) {
      case 'low': return { reverbRoomSize: 0.7, partialCount: 1, useSpatial: false };
      case 'medium': return { reverbRoomSize: 0.85, partialCount: 3, useSpatial: true };
      case 'high': return { reverbRoomSize: 0.9, partialCount: 5, useSpatial: true };
    }
  }
}

/**
 * 3.5 MASTER CHAIN (EQ -> Comp -> Limit)
 */
class MasterChain {
  public input: Tone.EQ3;
  private compressor: Tone.Compressor;
  private limiter: Tone.Limiter;

  constructor() {
    this.limiter = new Tone.Limiter(-0.5).toDestination();
    this.compressor = new Tone.Compressor({
      threshold: -24,
      ratio: 3,
      attack: 0.003,
      release: 0.25,
      knee: 10
    });
    this.input = new Tone.EQ3({
      low: 0,
      mid: -2,
      high: -4, // Softer roll-off for Zen feel
      lowFrequency: 200,
      highFrequency: 4000
    });

    this.input.chain(this.compressor, this.limiter);
  }

  dispose() {
    safeDispose(this.input);
    safeDispose(this.compressor);
    safeDispose(this.limiter);
  }
}

/**
 * 3.1 PSYCHOACOUSTIC BOWL SYNTH
 * Uses FM Synthesis with inharmonic partials for realistic beating
 */
class TibetanBowlSynth {
  private output: Tone.Gain;
  private fundamental: Tone.FMSynth;
  private partials: Tone.FMSynth[];

  constructor(partialCount: number) {
    this.output = new Tone.Gain(0.6);
    
    // Fundamental (The "Hum")
    this.fundamental = new Tone.FMSynth({
      harmonicity: 1,
      modulationIndex: 2,
      oscillator: { type: "sine" },
      envelope: { attack: 0.1, decay: 4, sustain: 0.2, release: 8 },
      modulation: { type: "sine" },
      modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 }
    }).connect(this.output);

    // Inharmonic partials (The "Rim/Singing")
    // Ratios derived from spectral analysis of metal bowls
    const ratios = [2.51, 4.23, 5.91, 8.17, 9.84];
    
    this.partials = ratios.slice(0, partialCount).map((ratio, i) => {
      const partial = new Tone.FMSynth({
        harmonicity: ratio,
        modulationIndex: 15 + i * 3,
        oscillator: { type: "sine" },
        envelope: { attack: 0.01, decay: 2 - (i * 0.2), sustain: 0.1, release: 5 - i },
        modulation: { type: "sine" },
        modulationEnvelope: { attack: 0.01, decay: 0, sustain: 1, release: 0.5 }
      }).connect(this.output);
      
      partial.volume.value = -12 - (i * 4); // Higher partials are quieter
      return partial;
    });
  }

  trigger(note: Tone.FrequencyClass | string, duration: number) {
    const now = Tone.now();
    // Strike fundamental
    this.fundamental.triggerAttackRelease(note, duration + 2, now);
    
    // Stagger partials (Micro-timing for realism)
    this.partials.forEach((partial, i) => {
      partial.triggerAttackRelease(
        note, 
        duration + 1 - (i * 0.2), 
        now + (i * 0.005) // 5ms stagger
      );
    });
  }

  connect(dest: Tone.ToneAudioNode) {
    this.output.connect(dest);
  }

  dispose() {
    safeDispose(this.fundamental);
    this.partials.forEach(p => safeDispose(p));
    safeDispose(this.output);
  }
}

/**
 * 3.2 SPATIAL AUDIO ENGINE
 */
class SpatialAudioEngine {
  private sources: Map<string, Tone.Panner3D | Tone.Panner>;
  private isHighQuality: boolean;

  constructor(isHighQuality: boolean) {
    this.isHighQuality = isHighQuality;
    this.sources = new Map();
  }

  createSource(id: string, x: number, y: number, z: number): Tone.ToneAudioNode {
    // Clean up existing source with same ID if any
    try {
        if (this.sources.has(id)) {
            const oldSource = this.sources.get(id);
            safeDispose(oldSource);
            this.sources.delete(id);
        }
    } catch(e) { /* Ignore cleanup errors */ }

    let panner: Tone.ToneAudioNode;

    if (this.isHighQuality) {
      try {
        // Panner3D is fragile. It often causes "A value with the given key could not be found"
        // if the HRTF database isn't loaded or if the AudioContext is in a specific state.
        // We trap this specifically and fallback to stereo.
        panner = new Tone.Panner3D({
          panningModel: 'HRTF',
          positionX: x,
          positionY: y,
          positionZ: z,
          refDistance: 1,
          rolloffFactor: 1
        });
      } catch (e) {
        console.warn(`Panner3D creation failed for ${id}, fallback to Stereo`, e);
        panner = new Tone.Panner(Math.max(-1, Math.min(1, x)));
      }
    } else {
      // Simple Stereo Panner
      panner = new Tone.Panner(Math.max(-1, Math.min(1, x))); 
    }
    
    this.sources.set(id, panner as any);
    return panner;
  }
  
  dispose() {
     this.sources.forEach(s => safeDispose(s));
     this.sources.clear();
  }
}

// --- INSTANCES ---
let audioManager: AdaptiveAudioManager | null = null;
let masterChain: MasterChain | null = null;
let spatialEngine: SpatialAudioEngine | null = null;
let masterReverb: Tone.Freeverb | null = null;

// Instruments
let bowlSynth: TibetanBowlSynth | null = null;
let padSynth: Tone.PolySynth | null = null;
let padChorus: Tone.Chorus | null = null;
let breathInSynth: Tone.NoiseSynth | null = null;
let breathOutSynth: Tone.NoiseSynth | null = null;
let breathFilter: Tone.Filter | null = null;

const CHORDS = {
  warm: ['C3', 'G3', 'B3', 'E4'], 
  neutral: ['D3', 'A3', 'C4', 'F4'],
  cool: ['A2', 'E3', 'B3', 'C#4']
};

/**
 * TTS Helper with iOS "Warm-up" strategy
 */
const speak = (text: string, lang: Language) => {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  
  // Cancel existing to prevent queue pile-up
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === 'vi' ? 'vi-VN' : 'en-US';
  utterance.rate = 0.85; 
  utterance.pitch = lang === 'vi' ? 0.9 : 1.0;
  utterance.volume = 0.8;
  
  const voices = window.speechSynthesis.getVoices();
  const preferredVoice = voices.find(v => 
    v.lang.includes(lang === 'vi' ? 'vi' : 'en') && 
    (v.name.includes('Google') || v.name.includes('Premium') || v.name.includes('Enhanced') || v.name.includes('Siri'))
  );
  
  if (preferredVoice) utterance.voice = preferredVoice;
  utterance.onerror = (e) => console.warn("TTS Error:", e);
  window.speechSynthesis.speak(utterance);
};

export const unlockAudio = async () => {
  if (isUnlocked && Tone.context.state === 'running' && masterChain) return true;
  if (isSettingUp) return false;

  try {
    // 1. Ensure Context State
    if (Tone.context.state !== 'running') {
        await Tone.start();
    }
    if (Tone.context.state !== 'running') {
      await Tone.context.resume();
    }

    // 2. Setup Graph if missing
    if (!masterChain) {
      await setupInstruments();
    }

    // 3. TTS Warmup (Mobile Safari Fix)
    if (typeof window !== 'undefined' && window.speechSynthesis) {
        try {
            window.speechSynthesis.cancel();
            const warmUp = new SpeechSynthesisUtterance(' ');
            warmUp.volume = 0;
            window.speechSynthesis.speak(warmUp);
        } catch (e) {
            console.warn("TTS Warmup warning:", e);
        }
    }

    // 4. Silent Pulse to wake the graph
    const buffer = Tone.context.createBuffer(1, 1, Tone.context.sampleRate);
    const source = Tone.context.createBufferSource();
    source.buffer = buffer;
    source.connect(Tone.context.destination);
    source.start(0);

    console.log("ZenB Audio Engine: 3.1 Activated");
    isUnlocked = true;
    return true;
  } catch (e) {
    console.error("Audio Unlock Failed:", e);
    // Brutal cleanup on failure to ensure next attempt starts fresh
    isUnlocked = false;
    isSettingUp = false;
    cleanupGraph();
    return false;
  }
};

/**
 * REFACTORED CLEANUP:
 * Never throw. Nullify references immediately.
 */
function cleanupGraph() {
  try {
    // 1. Sources
    bowlSynth?.dispose();
    padSynth?.dispose();
    padChorus?.dispose();
    breathInSynth?.dispose();
    breathOutSynth?.dispose();
    breathFilter?.dispose();
    
    // 2. Middlewares
    spatialEngine?.dispose();
    masterReverb?.dispose();
    
    // 3. Destination
    masterChain?.dispose();
  } catch (e) {
    console.warn("Audio cleanup warning (ignorable):", e);
  } finally {
    // Force nullify to prevent zombie access
    masterChain = null;
    spatialEngine = null;
    masterReverb = null;
    bowlSynth = null;
    padSynth = null;
    padChorus = null;
    breathInSynth = null;
    breathOutSynth = null;
    breathFilter = null;
  }
}

async function createAudioGraph(forceSafeMode: boolean) {
  audioManager = new AdaptiveAudioManager();
  let config = audioManager.getConfig();

  if (forceSafeMode) {
      console.log("ZenB: Initializing in Safe Mode (Stereo, Reduced DSP)");
      config = { reverbRoomSize: 0.5, partialCount: 1, useSpatial: false };
  }

  // 1. Master Chain
  masterChain = new MasterChain();
  
  // 2. Reverb
  masterReverb = new Tone.Freeverb({
      roomSize: config.reverbRoomSize,
      dampening: 3000,
      wet: 0.4
  });
  
  if (masterChain?.input) {
      masterReverb.connect(masterChain.input);
  }

  // 3. Spatial Engine
  spatialEngine = new SpatialAudioEngine(config.useSpatial);

  // --- INST: BOWL ---
  bowlSynth = new TibetanBowlSynth(config.partialCount);
  const bowlPanner = spatialEngine.createSource('bowl', 0, 0.5, -1);
  bowlSynth.connect(bowlPanner);
  bowlPanner.connect(masterReverb);

  // --- INST: PAD ---
  padChorus = new Tone.Chorus(2.5, 4.5, 0.4).start();
  padSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 3, spread: 20 },
      envelope: { attack: 2, decay: 3, sustain: 0.6, release: 4 }
  }).connect(padChorus);
  padSynth.volume.value = -14;
  padChorus.connect(masterReverb);

  // --- INST: BREATH ---
  breathFilter = new Tone.Filter(400, "lowpass", -12);
  
  breathInSynth = new Tone.NoiseSynth({
      noise: { type: 'brown' },
      envelope: { attack: 0.5, decay: 0.1, sustain: 1, release: 1.5 }
  }).connect(breathFilter);
  breathInSynth.volume.value = -12;

  breathOutSynth = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.5, decay: 0.1, sustain: 1, release: 1.5 }
  }).connect(breathFilter);
  breathOutSynth.volume.value = -16;

  const breathPanner = spatialEngine.createSource('breath', 0, 0, 0.5); 
  breathFilter.connect(breathPanner);
  breathPanner.connect(masterReverb);
}

async function setupInstruments() {
  if (isSettingUp) return;
  isSettingUp = true;

  // Dispose previous instances safely
  cleanupGraph();

  try {
    // Try Standard/High Quality first
    await createAudioGraph(false);
    console.log("ZenB Instruments: Harmonized (Standard Mode)");
  } catch (error) {
    console.warn("Setup Instruments Failed (High Quality)", error);
    
    try {
        // Fallback to Safe Mode
        cleanupGraph();
        await createAudioGraph(true);
        console.log("ZenB Instruments: Harmonized (Safe Mode)");
    } catch (fatalError) {
        console.error("Setup Instruments Failed (Safe Mode)", fatalError);
        isUnlocked = false;
        throw fatalError;
    }
  } finally {
    isSettingUp = false;
  }
}

export async function playCue(
  cue: CueType,
  enabled: boolean,
  pack: SoundPack,
  duration: number,
  lang: Language = 'en'
): Promise<void> {
  if (!enabled) return;
  if (isSettingUp) return;

  // Prevent playback if graph is dead
  if (!masterChain || !bowlSynth || !padSynth) { 
      // Only attempt unlock if not already trying
      if (!isSettingUp) unlockAudio().catch(e => console.error("Auto-setup failed", e));
      return; 
  }

  if (Tone.context.state !== 'running') { 
      try { await Tone.context.resume(); } catch {}
  }

  const time = Tone.now();
  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;

  try {
    if (pack === 'musical') {
      if (cue === 'inhale') padSynth?.triggerAttackRelease(CHORDS.warm, duration + 1, time);
      else if (cue === 'exhale') padSynth?.triggerAttackRelease(CHORDS.neutral, duration + 1, time);
      else if (cue === 'hold') bowlSynth?.trigger("E5", 0.5);
    } 
    else if (pack === 'bells') {
      if (cue === 'inhale') bowlSynth?.trigger("C3", duration + 4);
      else if (cue === 'exhale') bowlSynth?.trigger("G2", duration + 4);
      else if (cue === 'hold') bowlSynth?.trigger("C5", 2);
    }
    else if (pack === 'breath') {
      if (cue === 'inhale') {
        try { breathFilter?.frequency.cancelScheduledValues(time); } catch {}
        breathFilter?.frequency.setValueAtTime(200, time);
        breathFilter?.frequency.exponentialRampTo(1000, duration * 0.9, time);
        breathInSynth?.triggerAttackRelease(duration, time);
      } else if (cue === 'exhale') {
        try { breathFilter?.frequency.cancelScheduledValues(time); } catch {}
        breathFilter?.frequency.setValueAtTime(800, time);
        breathFilter?.frequency.exponentialRampTo(150, duration * 0.9, time);
        breathOutSynth?.triggerAttackRelease(duration, time);
      }
    }
    else if (pack.startsWith('voice')) {
       let text = "";
       if (pack === 'voice-12') {
         if (cue === 'inhale') text = lang === 'vi' ? "Một" : "One";
         if (cue === 'exhale') text = lang === 'vi' ? "Hai" : "Two";
       } else {
         if (cue === 'inhale') text = t.phases.inhale;
         if (cue === 'exhale') text = t.phases.exhale;
         if (cue === 'hold') text = t.phases.hold;
       }
       if (text) speak(text.toLowerCase(), lang);
    }
  } catch (e) {
    console.warn("Play error:", e);
  }
}

export function cleanupAudio() {
  if (padSynth) {
      try { padSynth.releaseAll(); } catch {}
  }
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}
