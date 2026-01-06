
import { BreathPattern, BreathPhase, KernelEvent, BeliefState, Observation, SafetyProfile, BREATHING_PATTERNS } from "../types";
import { nextPhaseSkipZero, isCycleBoundary } from "./phaseMachine";
import { PersistentEventStore } from "./eventStore";

/**
 * 🜂 ZENB KERNEL (Biological Operating System)
 * 
 * IMPLEMENTATION NOTE:
 * This Kernel follows the Manifesto's "Safety-by-Construction" principle.
 * 
 * Architecture:
 * 1. Event Log (Immutable Truth)
 * 2. Reducer (Pure Function: Event + State -> State)
 * 3. Safety Plane (Interceptor: Intention -> Guard -> Event)
 * 4. Active Inference (Controller: Observation -> Prediction Error -> Action)
 */

export type RuntimeState = {
  // --- KERNEL STATUS ---
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'HALTED' | 'SAFETY_LOCK';
  bootTimestamp: number;
  
  // --- PROCESS CONTROL ---
  pattern: BreathPattern | null;
  phase: BreathPhase;
  phaseElapsed: number;
  phaseDuration: number;
  cycleCount: number;
  sessionDuration: number;
  
  // --- INTERNAL MODEL (The "Mind") ---
  belief: BeliefState;
  
  // --- SENSOR DRIVER CACHE ---
  lastObservation: Observation | null;
  
  // --- SAFETY REGISTRY (Loaded from disk) ---
  safetyRegistry: Record<string, SafetyProfile>;
};

// --- SUBSYSTEM: ACTIVE INFERENCE (Free Energy Minimization) ---
class FreeEnergyController {
  
  /**
   * Calculates "Surprisal" (Free Energy)
   * F = Energy(InternalModel) - Entropy(SensoryData)
   * Simplified: How much does reality diverge from our expectation?
   */
  public update(currentBelief: BeliefState, obs: Observation, targetPattern: BreathPattern | null): BeliefState {
    const dt = obs.delta_time;
    let { arousal, attention, rhythm_alignment, prediction_error } = currentBelief;

    // 1. GENERATE PREDICTION (What should be happening?)
    // In a flow state, we expect the user to be calm (low arousal), focused (high attention), and synced.
    const expected_arousal = 0.3; 
    const expected_attention = 0.8;
    
    // 2. PROCESS OBSERVATION (What is happening?)
    // If heart rate is available, use it to ground arousal
    let observed_arousal = arousal;
    if (obs.heart_rate && obs.hr_confidence && obs.hr_confidence > 0.6) {
        // Normalize HR (assuming 60-100 is resting range)
        const normalized_hr = Math.min(1, Math.max(0, (obs.heart_rate - 50) / 70));
        observed_arousal = observed_arousal * 0.9 + normalized_hr * 0.1; // Filtered update
    }

    const isDistracted = obs.user_interaction === 'pause' || obs.visibilty_state === 'hidden';

    // 3. CALCULATE PREDICTION ERROR (Free Energy)
    let error_arousal = Math.abs(observed_arousal - expected_arousal);
    let error_attention = isDistracted ? 1.0 : 0.0;
    
    // Total Free Energy (Scalar)
    const F = (error_arousal * 0.4) + (error_attention * 0.6) + ((1 - rhythm_alignment) * 0.3);

    // 4. UPDATE INTERNAL STATE (Gradient Descent on F)
    // We adjust belief to minimize F over time
    
    if (isDistracted) {
        attention = Math.max(0, attention - (1.0 * dt)); // Fast collapse
        rhythm_alignment = Math.max(0, rhythm_alignment - (0.5 * dt));
    } else {
        attention = Math.min(1, attention + (0.1 * dt)); // Slow rebuild
        rhythm_alignment = Math.min(1, rhythm_alignment + (0.2 * dt));
    }
    
    // Arousal moves towards observed
    arousal = arousal + (observed_arousal - arousal) * dt;

    return { 
        arousal, 
        attention, 
        rhythm_alignment, 
        prediction_error: F // Store F for visualization/Safety Guard
    };
  }
}

// --- SUBSYSTEM: SAFETY PLANE (The Guard) ---
class SafetyPlane {
  /**
   * The "Trauma Registry" logic.
   * Returns a blocking event if the action violates safety constraints.
   */
  public intercept(state: RuntimeState, intention: KernelEvent): KernelEvent | null {
    
    // RULE 1: Lockout Enforcement
    if (state.status === 'SAFETY_LOCK' && intention.type === 'START_SESSION') {
         return { 
             type: 'SAFETY_INTERDICTION', 
             riskLevel: 1.0, 
             action: 'REJECT_START', 
             timestamp: Date.now() 
         };
    }

    // RULE 2: High Entropy Cutoff (Trauma Prevention)
    if (intention.type === 'TICK' && state.status === 'RUNNING') {
        if (state.belief.prediction_error > 0.95 && state.sessionDuration > 10) {
            // Free Energy is critical -> System is chaotic -> Emergency Halt
            return {
                type: 'SAFETY_INTERDICTION',
                riskLevel: 0.95,
                action: 'EMERGENCY_DAMPENING', // Slow down or stop
                timestamp: Date.now()
            };
        }
    }

    // RULE 3: Pattern Suitability
    if (intention.type === 'LOAD_PROTOCOL') {
        const profile = state.safetyRegistry[intention.patternId];
        if (profile && profile.safety_lock_until > Date.now()) {
             return {
                 type: 'SAFETY_INTERDICTION',
                 riskLevel: 0.8,
                 action: 'PATTERN_LOCKED',
                 timestamp: Date.now()
             };
        }
    }

    return null; // Allowed
  }
}

// --- MAIN RUNTIME ---

class ZenBKernel {
  private state: RuntimeState;
  private eventStore = new PersistentEventStore();
  private controller = new FreeEnergyController();
  private safetyPlane = new SafetyPlane();
  
  private subscribers = new Set<(s: RuntimeState) => void>();
  private logBuffer: KernelEvent[] = []; // Short-term memory for UI

  constructor() {
    this.state = this.getInitialState();
    this.eventStore.init();
    
    // Boot sequence
    this.dispatch({ type: 'BOOT', timestamp: Date.now() });
  }

  private getInitialState(): RuntimeState {
    return {
      status: 'IDLE',
      bootTimestamp: Date.now(),
      pattern: null,
      phase: 'inhale',
      phaseElapsed: 0,
      phaseDuration: 0,
      cycleCount: 0,
      sessionDuration: 0,
      belief: { 
          arousal: 0.5, 
          attention: 0.5, 
          rhythm_alignment: 0, 
          prediction_error: 0 
      },
      lastObservation: null,
      safetyRegistry: {}
    };
  }

  public getState() { return this.state; }
  public getLogBuffer() { return this.logBuffer; } // For KernelMonitor

  public subscribe(cb: (s: RuntimeState) => void) {
    this.subscribers.add(cb);
    cb(this.state);
    return () => this.subscribers.delete(cb);
  }
  
  public loadSafetyRegistry(registry: Record<string, SafetyProfile>) {
      this.state.safetyRegistry = registry;
  }

  /**
   * THE EVENT BUS (Write)
   * All state changes MUST pass through here.
   */
  public dispatch(intention: KernelEvent) {
    // 1. Safety Interception
    const interdiction = this.safetyPlane.intercept(this.state, intention);
    
    const eventToProcess = interdiction || intention;
    
    // 2. Persistence (Write-Ahead Log)
    this.eventStore.append(eventToProcess);
    this.logBuffer = [eventToProcess, ...this.logBuffer].slice(0, 50);

    // 3. State Reduction
    this.reduce(eventToProcess);

    // 4. Notify Views
    this.notify();
  }

  /**
   * THE REDUCER (Pure Logic)
   */
  private reduce(event: KernelEvent) {
    switch (event.type) {
        case 'BOOT':
            this.state.status = 'IDLE';
            break;
            
        case 'LOAD_PROTOCOL':
            // Logic: Reset ephemeral state, keep safety registry
            if (this.state.status === 'SAFETY_LOCK') return; 
            const pattern = BREATHING_PATTERNS[event.patternId];
            if (pattern) {
                this.state.pattern = pattern;
                this.state.phase = 'inhale';
                this.state.phaseDuration = pattern.timings.inhale;
                this.state.phaseElapsed = 0;
                this.state.cycleCount = 0;
                this.state.sessionDuration = 0;
                this.state.status = 'IDLE';
                // Reset belief to priors
                this.state.belief = { ...this.state.belief, rhythm_alignment: 0, prediction_error: 0 };
            }
            break;

        case 'START_SESSION':
            if (this.state.pattern) this.state.status = 'RUNNING';
            break;

        case 'INTERRUPTION':
            if (this.state.status === 'RUNNING') this.state.status = 'PAUSED';
            break;

        case 'RESUME':
            if (this.state.status === 'PAUSED') this.state.status = 'RUNNING';
            break;

        case 'HALT':
            this.state.status = 'IDLE';
            this.state.phaseElapsed = 0;
            break;

        case 'SAFETY_INTERDICTION':
            if (event.action === 'EMERGENCY_DAMPENING') {
                // Constructive Interference: Switch to Safe Mode
                this.state.status = 'SAFETY_LOCK';
                console.warn("KERNEL PANIC: Safety Interdiction Triggered");
            }
            break;

        case 'PHASE_TRANSITION':
            this.state.phase = event.to;
            this.state.phaseElapsed = 0;
            if (this.state.pattern) {
                this.state.phaseDuration = this.state.pattern.timings[event.to];
            }
            break;

        case 'CYCLE_COMPLETE':
            this.state.cycleCount = event.count;
            break;
            
        case 'TICK':
            this.handleTick(event.dt);
            break;
            
        case 'ADAPTATION':
            if (this.state.pattern) {
                // Apply neuro-plasticity updates to the running pattern
                // Note: In strict Redux, we'd need a deep clone, but for perf we mutate the ephemeral pattern object
                // provided we don't mutate the const definition.
                const newTimings = { ...this.state.pattern.timings };
                // Example: event.parameter might be 'timings.inhale'
                // This is a simplified application
            }
            break;
    }
  }

  private handleTick(dt: number) {
      if (this.state.status !== 'RUNNING' && this.state.status !== 'PAUSED') return;

      // 1. Synthesize Observation
      const obs: Observation = {
          timestamp: Date.now(),
          delta_time: dt,
          visibilty_state: document.hidden ? 'hidden' : 'visible',
          user_interaction: this.state.status === 'PAUSED' ? 'pause' : undefined,
          heart_rate: this.state.lastObservation?.heart_rate,
          hr_confidence: this.state.lastObservation?.hr_confidence
      };

      // 2. Active Inference Step (The Brain)
      this.state.belief = this.controller.update(this.state.belief, obs, this.state.pattern);

      // 3. Physics Step (The Body)
      if (this.state.status === 'RUNNING' && this.state.pattern) {
          this.state.phaseElapsed += dt;
          this.state.sessionDuration += dt;
          
          if (this.state.phaseElapsed >= this.state.phaseDuration) {
              const next = nextPhaseSkipZero(this.state.phase, this.state.pattern);
              this.dispatch({ type: 'PHASE_TRANSITION', from: this.state.phase, to: next, timestamp: Date.now() });
              
              if (isCycleBoundary(next)) {
                  this.dispatch({ type: 'CYCLE_COMPLETE', count: this.state.cycleCount + 1, timestamp: Date.now() });
              }
          }
      }
  }

  // --- SENSOR DRIVER API ---
  public ingestObservation(obs: Observation) {
      this.state.lastObservation = obs;
      // We don't dispatch every sensor frame to EventLog to save space, 
      // but we update the runtime cache. 
      // Significant changes could trigger an 'OBSERVATION_INGEST' event.
  }

  private notify() {
      this.subscribers.forEach(cb => cb({ ...this.state }));
  }
}

export const kernel = new ZenBKernel();
