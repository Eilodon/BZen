import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { KernelEvent } from '../types';

interface ZenBEventsDB extends DBSchema {
  events: {
    key: number; // timestamp
    value: KernelEvent;
    indexes: { 'by-type': string };
  };
  sessions: {
    key: string; // session ID
    value: {
      id: string;
      startTime: number;
      endTime: number;
      patternId: string;
      eventCount: number;
    };
  };
}

export class PersistentEventStore {
  private db: IDBPDatabase<ZenBEventsDB> | null = null;
  private writeBuffer: KernelEvent[] = [];
  private flushInterval: any = null;
  
  async init() {
    try {
      this.db = await openDB<ZenBEventsDB>('zenb-events', 1, {
        upgrade(db) {
          // Events store
          const eventStore = db.createObjectStore('events', { keyPath: 'timestamp' });
          eventStore.createIndex('by-type', 'type');
          
          // Sessions store
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
      });
      
      // Batch writes every 2 seconds
      this.flushInterval = setInterval(() => this.flush(), 2000);
      
      console.log('[EventStore] Initialized');
    } catch (e) {
      console.error('[EventStore] Initialization failed', e);
    }
  }
  
  /**
   * Append event to write buffer
   * Actual write happens on flush()
   */
  append(event: KernelEvent) {
    this.writeBuffer.push(event);
    
    // Emergency flush if buffer gets large
    if (this.writeBuffer.length > 100) {
      this.flush();
    }
  }
  
  /**
   * Flush write buffer to IndexedDB
   */
  private async flush() {
    if (!this.db || this.writeBuffer.length === 0) return;
    
    const eventsToWrite = [...this.writeBuffer];
    this.writeBuffer = [];

    try {
        const tx = this.db.transaction('events', 'readwrite');
        const store = tx.objectStore('events');
        
        for (const event of eventsToWrite) {
          // Wrap put in try-catch to ignore duplicate key errors if timestamps are identical
          try {
             await store.put(event);
          } catch(e) {
             console.warn('[EventStore] Skipped duplicate event key', event.timestamp);
          }
        }
        
        await tx.done;
    } catch(e) {
        console.error('[EventStore] Flush error', e);
    }
  }
  
  /**
   * Get all events in time range
   */
  async getRange(fromTimestamp: number, toTimestamp: number): Promise<KernelEvent[]> {
    if (!this.db) return [];
    
    const range = IDBKeyRange.bound(fromTimestamp, toTimestamp);
    return await this.db.getAll('events', range);
  }
  
  /**
   * Get events by type
   */
  async getByType(type: string): Promise<KernelEvent[]> {
    if (!this.db) return [];
    return await this.db.getAllFromIndex('events', 'by-type', type);
  }
  
  /**
   * Clear old events (keep last 30 days)
   */
  async cleanup() {
    if (!this.db) return;
    
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const range = IDBKeyRange.upperBound(thirtyDaysAgo);
    
    const tx = this.db.transaction('events', 'readwrite');
    const store = tx.objectStore('events');
    
    let cursor = await store.openCursor(range);
    let deletedCount = 0;
    
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
      deletedCount++;
    }
    
    if (deletedCount > 0) {
       console.log(`[EventStore] Cleaned up ${deletedCount} old events`);
    }
  }
  
  /**
   * Replay events to reconstruct state
   */
  async replay(fromTimestamp: number): Promise<KernelEvent[]> {
    const events = await this.getRange(fromTimestamp, Date.now());
    console.log(`[EventStore] Replaying ${events.length} events from ${new Date(fromTimestamp)}`);
    return events;
  }
  
  dispose() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flush(); // Final flush
    this.db?.close();
  }
}
