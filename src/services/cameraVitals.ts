import * as tf from '@tensorflow/tfjs';
import * as faceLandmarksDetection from '@tensorflow-models/face-landmarks-detection';

export interface VitalSigns {
  heartRate: number;        // BPM (0 if not detected)
  confidence: number;       // 0.0 - 1.0
  signalQuality: 'poor' | 'fair' | 'good';
}

/**
 * Camera-based Vital Signs Detection using rPPG
 * 
 * How it works:
 * 1. Detect face using TensorFlow.js FaceMesh
 * 2. Extract green channel from forehead/cheek ROIs
 * 3. Green light is most sensitive to blood volume changes
 * 4. Apply bandpass filter (0.75-3Hz = 45-180 BPM)
 * 5. Find dominant frequency → Heart Rate
 */
export class CameraVitalsEngine {
  private detector: faceLandmarksDetection.FaceLandmarksDetector | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  
  // Signal processing buffers
  private greenSignalBuffer: number[] = [];
  private readonly BUFFER_SIZE = 256; // ~4 seconds at 60fps
  private readonly MIN_BUFFER_SIZE = 128; // Minimum for FFT
  
  // Quality tracking
  private lastFaceDetectTime = 0;
  private consecutiveDetections = 0;
  
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
  }
  
  /**
   * Initialize TensorFlow and load face detection model
   */
  async init(): Promise<void> {
    await tf.ready();
    await tf.setBackend('webgl'); // Use GPU
    
    this.detector = await faceLandmarksDetection.createDetector(
      faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
      {
        runtime: 'tfjs',
        maxFaces: 1,
        refineLandmarks: false // Faster without refinement
      }
    );
    
    console.log('[rPPG] Camera vitals engine initialized');
  }
  
  /**
   * Process a single video frame
   * Call this in requestAnimationFrame loop
   */
  async processFrame(video: HTMLVideoElement): Promise<VitalSigns> {
    if (!this.detector) {
      throw new Error('Engine not initialized. Call init() first.');
    }
    
    // Detect face landmarks
    const faces = await this.detector.estimateFaces(video);
    
    if (faces.length === 0) {
      this.consecutiveDetections = 0;
      return {
        heartRate: 0,
        confidence: 0,
        signalQuality: 'poor'
      };
    }
    
    this.consecutiveDetections++;
    this.lastFaceDetectTime = performance.now();
    
    // Extract ROI (Region of Interest): Forehead
    // FaceMesh landmark indices for forehead: 10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288
    const face = faces[0];
    const foreheadLandmarks = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288]
      .map(idx => face.keypoints[idx]);
    
    // Calculate bounding box of forehead
    const xs = foreheadLandmarks.map(p => p.x);
    const ys = foreheadLandmarks.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    
    // Extract green channel from ROI
    const greenValue = this.extractGreenChannel(video, minX, minY, maxX, maxY);
    
    // Add to buffer
    this.greenSignalBuffer.push(greenValue);
    if (this.greenSignalBuffer.length > this.BUFFER_SIZE) {
      this.greenSignalBuffer.shift();
    }
    
    // Need minimum samples for FFT
    if (this.greenSignalBuffer.length < this.MIN_BUFFER_SIZE) {
      return {
        heartRate: 0,
        confidence: 0,
        signalQuality: 'poor'
      };
    }
    
    // Calculate heart rate
    const heartRate = this.calculateHeartRate();
    const confidence = this.calculateConfidence();
    const signalQuality = this.assessSignalQuality(confidence);
    
    return { heartRate, confidence, signalQuality };
  }
  
  /**
   * Extract average green channel value from ROI
   */
  private extractGreenChannel(
    video: HTMLVideoElement,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): number {
    const width = maxX - minX;
    const height = maxY - minY;
    
    // Draw ROI to canvas
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(video, minX, minY, width, height, 0, 0, width, height);
    
    // Get pixel data
    const imageData = this.ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data;
    
    // Average green channel (index 1 in RGBA)
    let greenSum = 0;
    let pixelCount = 0;
    
    for (let i = 1; i < pixels.length; i += 4) {
      greenSum += pixels[i];
      pixelCount++;
    }
    
    return greenSum / pixelCount;
  }
  
  /**
   * Calculate heart rate using FFT
   * Find dominant frequency in 0.75-3Hz range (45-180 BPM)
   */
  private calculateHeartRate(): number {
    const signal = this.greenSignalBuffer;
    const n = signal.length;
    
    // Detrend: Remove DC component
    const mean = signal.reduce((a, b) => a + b, 0) / n;
    const detrended = signal.map(x => x - mean);
    
    // Apply Hamming window to reduce spectral leakage
    const windowed = detrended.map((x, i) => {
      const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
      return x * window;
    });
    
    // Simple FFT implementation (for production, use fft.js library)
    const fft = this.simpleFFT(windowed);
    
    // Find peak in 0.75-3Hz range
    // Assuming 60fps: frequency resolution = 60 / n
    const fps = 60;
    const freqResolution = fps / n;
    const minFreqBin = Math.floor(0.75 / freqResolution);
    const maxFreqBin = Math.floor(3.0 / freqResolution);
    
    let maxPower = 0;
    let peakBin = 0;
    
    for (let i = minFreqBin; i <= maxFreqBin; i++) {
      const power = fft[i];
      if (power > maxPower) {
        maxPower = power;
        peakBin = i;
      }
    }
    
    // Convert bin to frequency, then to BPM
    const peakFreq = peakBin * freqResolution;
    const bpm = peakFreq * 60;
    
    // Sanity check
    if (bpm < 45 || bpm > 180) return 0;
    
    return Math.round(bpm);
  }
  
  /**
   * Simplified FFT (magnitude only)
   * For production, use: npm install fft.js
   */
  private simpleFFT(signal: number[]): number[] {
    const n = signal.length;
    const magnitudes: number[] = [];
    
    for (let k = 0; k < n / 2; k++) {
      let real = 0;
      let imag = 0;
      
      for (let i = 0; i < n; i++) {
        const angle = -2 * Math.PI * k * i / n;
        real += signal[i] * Math.cos(angle);
        imag += signal[i] * Math.sin(angle);
      }
      
      magnitudes[k] = Math.sqrt(real * real + imag * imag);
    }
    
    return magnitudes;
  }
  
  /**
   * Calculate confidence based on signal quality indicators
   */
  private calculateConfidence(): number {
    let score = 0;
    
    // Factor 1: Sufficient data
    if (this.greenSignalBuffer.length >= this.BUFFER_SIZE) score += 0.3;
    else score += (this.greenSignalBuffer.length / this.BUFFER_SIZE) * 0.3;
    
    // Factor 2: Stable face detection
    if (this.consecutiveDetections > 30) score += 0.3; // > 0.5 seconds
    else score += (this.consecutiveDetections / 30) * 0.3;
    
    // Factor 3: Signal variance (good signal has periodic variance)
    const signal = this.greenSignalBuffer.slice(-60); // Last second
    if (signal.length > 10) {
      const mean = signal.reduce((a, b) => a + b) / signal.length;
      const variance = signal.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / signal.length;
      const normalizedVariance = Math.min(variance / 100, 1); // Normalize
      score += normalizedVariance * 0.4;
    }
    
    return Math.min(score, 1.0);
  }
  
  /**
   * Assess overall signal quality
   */
  private assessSignalQuality(confidence: number): 'poor' | 'fair' | 'good' {
    if (confidence < 0.3) return 'poor';
    if (confidence < 0.7) return 'fair';
    return 'good';
  }
  
  /**
   * Cleanup resources
   */
  dispose(): void {
    if (this.detector) {
      this.detector.dispose();
      this.detector = null;
    }
  }
}