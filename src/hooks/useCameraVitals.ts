import { useEffect, useState, useRef } from 'react';
import { CameraVitalsEngine, VitalSigns } from '../services/cameraVitals';

export function useCameraVitals(enabled: boolean) {
  const [vitals, setVitals] = useState<VitalSigns>({
    heartRate: 0,
    confidence: 0,
    signalQuality: 'poor'
  });
  
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  
  const engineRef = useRef<CameraVitalsEngine>();
  const videoRef = useRef<HTMLVideoElement>();
  const streamRef = useRef<MediaStream>();
  const rafRef = useRef<number>();
  
  useEffect(() => {
    if (!enabled) {
      cleanup();
      return;
    }
    
    let mounted = true;
    
    const init = async () => {
      try {
        // Initialize engine
        const engine = new CameraVitalsEngine();
        await engine.init();
        engineRef.current = engine;
        
        // Request camera access
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 } // Lower framerate for performance
          }
        });
        streamRef.current = stream;
        
        // Create video element
        const video = document.createElement('video');
        video.srcObject = stream;
        video.playsInline = true;
        video.muted = true;
        await video.play();
        videoRef.current = video;
        
        if (!mounted) {
          cleanup();
          return;
        }
        
        setIsReady(true);
        
        // Start processing loop
        const processLoop = async () => {
          if (!engineRef.current || !videoRef.current || !mounted) return;
          
          try {
            const result = await engineRef.current.processFrame(videoRef.current);
            if (mounted) {
              setVitals(result);
            }
          } catch (err) {
            console.error('[rPPG] Processing error:', err);
          }
          
          rafRef.current = requestAnimationFrame(processLoop);
        };
        
        processLoop();
        
      } catch (err: any) {
        console.error('[rPPG] Initialization failed:', err);
        setError(err.message || 'Camera access denied');
      }
    };
    
    init();
    
    return () => {
      mounted = false;
      cleanup();
    };
  }, [enabled]);
  
  const cleanup = () => {
    // Stop animation loop
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    
    // Stop camera stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    
    // Dispose engine
    if (engineRef.current) {
      engineRef.current.dispose();
    }
    
    setIsReady(false);
    setVitals({ heartRate: 0, confidence: 0, signalQuality: 'poor' });
  };
  
  return { vitals, isReady, error };
}