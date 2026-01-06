
import React, { useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { BreathPhase, UserSettings, CueType } from '../types';
import { playCue } from '../services/audio';
import { hapticPhase } from '../services/haptics';
import { kernel, RuntimeState } from '../services/ZenBKernel';
import { useCameraVitals } from './useCameraVitals';

type EngineRefs = {
  progressRef: React.MutableRefObject<number>;
  entropyRef: React.MutableRefObject<number>;
};

function phaseToCueType(phase: BreathPhase): 'inhale' | 'exhale' | 'hold' {
  if (phase === 'holdIn' || phase === 'holdOut') return 'hold';
  return phase;
}

/**
 * 🜂 DRIVER (View-Controller Bridge)
 * 
 * This hook acts as the "Main Loop" driver for the OS.
 * 1. It provides the "Clock" (TICK events) to the Kernel.
 * 2. It observes Kernel state to drive "Peripherals" (Screen, Speakers, Haptics).
 * 3. It ingests "Sensors" (Camera Vitals) into the Kernel.
 */
export function useBreathEngine(): EngineRefs {
  const isActive = useSessionStore((s) => s.isActive);
  const isPaused = useSessionStore((s) => s.isPaused);
  const currentPattern = useSessionStore((s) => s.currentPattern);
  const stopSession = useSessionStore((s) => s.stopSession);
  const syncState = useSessionStore((s) => s.syncState);
  
  const storeUserSettings = useSettingsStore((s) => s.userSettings);
  const settingsRef = useRef<UserSettings>(storeUserSettings);
  
  // Visual Interpolation Refs (Mutable, read by Three.js loop)
  const progressRef = useRef<number>(0);
  const entropyRef = useRef<number>(0); 
  
  const prevPhaseRef = useRef<BreathPhase>('inhale');

  // Sync Settings for Drivers (avoid closure staleness in effects)
  useEffect(() => {
    settingsRef.current = storeUserSettings;
  }, [storeUserSettings]);

  // --- SENSOR DRIVER: CAMERA VITALS ---
  const { vitals } = useCameraVitals(isActive && storeUserSettings.cameraVitalsEnabled);
  
  // Feed sensor data into Kernel Cache
  useEffect(() => {
    if (vitals.confidence > 0.3) {
      kernel.ingestObservation({
          timestamp: Date.now(),
          delta_time: 0,
          visibilty_state: 'visible',
          heart_rate: vitals.heartRate,
          hr_confidence: vitals.confidence
      });
    }
  }, [vitals]);

  // --- KERNEL CONTROL BUS ---
  
  // 1. Handle START / STOP signals from UI
  useEffect(() => {
    if (isActive) {
        // Boot Sequence
        kernel.dispatch({ type: 'LOAD_PROTOCOL', patternId: currentPattern.id, timestamp: Date.now() });
        kernel.dispatch({ type: 'START_SESSION', timestamp: Date.now() });
        prevPhaseRef.current = 'inhale';
    } else {
        // Shutdown Sequence
        progressRef.current = 0;
        kernel.dispatch({ type: 'HALT', reason: 'cleanup', timestamp: Date.now() });
    }
  }, [isActive, currentPattern.id]);

  // 2. Handle PAUSE / RESUME signals from UI
  useEffect(() => {
    if (!isActive) return;

    if (isPaused) {
       kernel.dispatch({ type: 'INTERRUPTION', kind: 'pause', timestamp: Date.now() });
    } else {
       kernel.dispatch({ type: 'RESUME', timestamp: Date.now() });
    }
  }, [isPaused, isActive]);

  // --- KERNEL EVENT OBSERVER (The Peripherals) ---
  useEffect(() => {
      // Subscribe to Kernel State changes
      const unsub = kernel.subscribe((state: RuntimeState) => {
          
          // A. Safety Monitor (Kernel Panic Handler)
          if (state.status === 'SAFETY_LOCK') {
              console.warn("ZenB Safety Intervention Triggered - Halting Session");
              stopSession();
              return;
          }

          // B. Visual Cortex Driver (Update Refs for Canvas)
          const denom = Math.max(state.phaseDuration, 0.001);
          // Calculate normalized progress (0.0 - 1.0)
          progressRef.current = Math.max(0, Math.min(state.phaseElapsed / denom, 1));
          
          // Visualize Free Energy as System Entropy (Chaos)
          entropyRef.current = state.belief.prediction_error;

          // C. UI State Sync (React Stores)
          // Only sync if discrete values change to avoid React render thrashing
          if (state.phase !== useSessionStore.getState().phase || state.cycleCount !== useSessionStore.getState().cycleCount) {
              syncState(state.phase, state.cycleCount);
          }

          // D. Haptic & Audio Drivers (Side Effects on Phase Transition)
          if (state.phase !== prevPhaseRef.current && state.status === 'RUNNING') {
                const st = settingsRef.current;
                const duration = state.phaseDuration;
                const cueType = phaseToCueType(state.phase);
                
                // Fire Haptics
                hapticPhase(st.hapticEnabled, st.hapticStrength, cueType);
                
                // Fire Audio
                playCue(cueType, st.soundEnabled, st.soundPack, duration, st.language);
                
                prevPhaseRef.current = state.phase;
          }
      });

      return unsub;
  }, [stopSession, syncState]);

  // --- CLOCK DRIVER (The Heartbeat) ---
  // Generates TICK events for the Kernel to process time
  useEffect(() => {
      if (!isActive) return;

      let lastTime = performance.now();
      let frameId: number;

      const tickLoop = (now: number) => {
          if (isPaused) {
              lastTime = now;
              frameId = requestAnimationFrame(tickLoop);
              return;
          }

          // Calculate delta time in seconds
          const dt = Math.min((now - lastTime) / 1000, 0.1); // Cap dt to prevent huge jumps on lag
          lastTime = now;

          // Dispatch TICK to Kernel
          // Note: The Kernel handles the physics integration (Active Inference + Phase Transition)
          kernel.dispatch({ type: 'TICK', dt, timestamp: Date.now() });

          frameId = requestAnimationFrame(tickLoop);
      };

      frameId = requestAnimationFrame(tickLoop);

      return () => {
          cancelAnimationFrame(frameId);
      };
  }, [isActive, isPaused]);

  return { progressRef, entropyRef };
}
