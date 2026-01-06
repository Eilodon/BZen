
import { BreathPattern, BreathingType, BREATHING_PATTERNS } from '../types';

/**
 * PID Controller for continuous control systems
 * Used to minimize error between target and actual state
 */
export class PIDController {
  private integral = 0;
  private lastError = 0;
  private lastTime = Date.now();
  
  constructor(
    private kp: number = 0.5,  // Proportional gain
    private ki: number = 0.1,  // Integral gain
    private kd: number = 0.2   // Derivative gain
  ) {}
  
  /**
   * Calculate control output
   * @param target - Desired value (e.g., coherence = 0.8)
   * @param current - Current value
   * @returns Correction value
   */
  update(target: number, current: number): number {
    const now = Date.now();
    const dt = (now - this.lastTime) / 1000; // Convert to seconds
    this.lastTime = now;
    
    // Calculate error
    const error = target - current;
    
    // Proportional term
    const p = this.kp * error;
    
    // Integral term (accumulated error)
    this.integral += error * dt;
    // Anti-windup: prevent integral from growing unbounded
    this.integral = Math.max(-10, Math.min(10, this.integral));
    const i = this.ki * this.integral;
    
    // Derivative term (rate of change)
    const derivative = dt > 0 ? (error - this.lastError) / dt : 0;
    const d = this.kd * derivative;
    
    this.lastError = error;
    
    return p + i + d;
  }
  
  reset() {
    this.integral = 0;
    this.lastError = 0;
    this.lastTime = Date.now();
  }
}

/**
 * Adaptive Breathing Engine
 * Adjusts patterns in real-time based on user's physiological state
 */
export class AdaptiveEngine {
  private coherencePID = new PIDController(0.3, 0.05, 0.1);
  private arousalPID = new PIDController(0.4, 0.08, 0.15);
  
  private targetCoherence = 0.75; // Goal: High HRV coherence
  private targetArousal = 0.3;    // Goal: Calm but alert
  
  /**
   * Optimize pattern based on current state
   */
  optimizePattern(
    currentPattern: BreathPattern,
    state: {
      heartRate: number;
      confidence: number;
      arousal: number;
      rhythm_alignment: number;
    }
  ): BreathPattern {
    // Need reliable vitals
    if (state.confidence < 0.5) {
      return currentPattern; // No adjustment without good data
    }
    
    // Calculate coherence (simplified: alignment is proxy for HRV coherence)
    const coherence = state.rhythm_alignment;
    
    // PID corrections
    const coherenceCorrection = this.coherencePID.update(this.targetCoherence, coherence);
    const arousalCorrection = this.arousalPID.update(this.targetArousal, state.arousal);
    
    // Combined correction (weighted)
    const totalCorrection = coherenceCorrection * 0.6 + arousalCorrection * 0.4;
    
    // Adjust timings
    // Positive correction → Lengthen phases (more calming)
    // Negative correction → Shorten phases (more energizing)
    const adjustmentFactor = 1 + (totalCorrection * 0.15); // Max ±15% adjustment
    const clampedFactor = Math.max(0.85, Math.min(1.15, adjustmentFactor));
    
    const optimized: BreathPattern = {
      ...currentPattern,
      timings: {
        inhale: Math.max(2, currentPattern.timings.inhale * clampedFactor),
        holdIn: Math.max(0, currentPattern.timings.holdIn * clampedFactor),
        exhale: Math.max(2, currentPattern.timings.exhale * clampedFactor),
        holdOut: Math.max(0, currentPattern.timings.holdOut * clampedFactor)
      }
    };
    
    return optimized;
  }
  
  /**
   * Estimate optimal resonance frequency for user
   * Typically 0.1 Hz (6 breaths/min) but varies by individual
   */
  estimateResonanceFrequency(heartRate: number): number {
    // Simplified heuristic: Lower resting HR → Lower resonance freq
    // Real implementation would use FFT on HRV signal
    
    if (heartRate < 60) return 0.09; // ~5.4 breaths/min
    if (heartRate < 70) return 0.10; // 6 breaths/min (standard)
    return 0.11; // ~6.6 breaths/min
  }
  
  /**
   * Suggest pattern based on current state
   */
  suggestPattern(state: {
    arousal: number;
    attention: number;
    timeOfDay: number; // Hour 0-23
  }): BreathingType {
    // High arousal → Need calming
    if (state.arousal > 0.7) {
      return '4-7-8'; // Most calming
    }
    
    // Low attention + late night → Sleep prep
    if (state.attention < 0.3 && state.timeOfDay >= 22) {
      return 'deep-relax';
    }
    
    // Morning → Energizing
    if (state.timeOfDay >= 6 && state.timeOfDay < 9) {
      return 'awake';
    }
    
    // Default: Balanced
    return 'coherence';
  }
  
  reset() {
    this.coherencePID.reset();
    this.arousalPID.reset();
  }
}
