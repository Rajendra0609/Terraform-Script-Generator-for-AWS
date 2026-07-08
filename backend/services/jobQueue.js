'use strict';
/**
 * Job queue service using BullMQ + Redis.
 * Falls back to in-process execution if Redis is unavailable (dev mode).
 *
 * Each job has: { type, hcl, projectId, userId, options }
 * Emits events via EventEmitter so WebSocket layer can stream logs.
 */
const { Queue, Worker, QueueEvents } = require('bullmq');
const EventEmitter = require('events');
const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Shared event bus: job-id → streaming log lines
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(200);

let queue, worker, queueEvents;
let redisAvailable = false;

const connection = { url: REDIS_URL };

function initQueue(processJob) {
  try {
    queue = new Queue('terraform-jobs', { connection, defaultJobOptions: { removeOnComplete: 100, removeOnFail: 200 } });
    queueEvents = new QueueEvents('terraform-jobs', { connection });

    worker = new Worker('terraform-jobs', async (job) => {
      return processJob(job.data, (line) => {
        jobEvents.emit(`log:${job.id}`, line);
      });
    }, {
      connection,
      concurrency: parseInt(process.env.JOB_CONCURRENCY || '5', 10),
    });

    worker.on('failed', (job, err) => {
      console.error(`[jobQueue] job ${job?.id} failed:`, err.message);
      jobEvents.emit(`done:${job?.id}`, { success: false, error: err.message });
    });

    worker.on('completed', (job, result) => {
      jobEvents.emit(`done:${job.id}`, result);
    });

    // BUG-017 fix: BullMQ connects lazily — the Queue/Worker constructors succeed
    // even when Redis is unreachable. Connection errors surface later as async
    // 'error' events. Without listeners, Node.js treats unhandled EventEmitter
    // errors as thrown exceptions and crashes the process.
    queue.on('error', (err) => {
      console.error('[jobQueue] Queue connection error:', err.message);
    });
    worker.on('error', (err) => {
      console.error('[jobQueue] Worker connection error:', err.message);
    });
    if (queueEvents) {
      queueEvents.on('error', (err) => {
        console.error('[jobQueue] QueueEvents connection error:', err.message);
      });
    }

    redisAvailable = true;
    console.info('[jobQueue] BullMQ connected to Redis');
  } catch (err) {
    console.warn('[jobQueue] Redis unavailable — falling back to in-process execution:', err.message);
    redisAvailable = false;
  }
}

/**
 * Enqueue a terraform job. Returns { jobId }.
 * If Redis is unavailable, runs synchronously and returns { jobId, result }.
 */
async function enqueue(data, processJobFn) {
  const jobId = crypto.randomUUID();
  data.jobId = jobId;

  if (!redisAvailable) {
    // Synchronous fallback for dev without Redis
    let result;
    try {
      result = await processJobFn(data, (line) => jobEvents.emit(`log:${jobId}`, line));
    } catch (err) {
      result = { success: false, error: err.message };
    }
    // Emit done after a tick so callers can subscribe first
    setImmediate(() => jobEvents.emit(`done:${jobId}`, result));
    return { jobId, result };
  }

  await queue.add(data.type, data, { jobId });
  return { jobId };
}

/**
 * Get current job status from queue.
 * Returns null if job not found or Redis unavailable.
 */
async function getJobStatus(jobId) {
  if (!redisAvailable || !queue) return null;
  try {
    // BUG-011 fix: Job.fromId() was removed in BullMQ v4+.
    // Use queue.getJob(jobId) which works across all supported versions.
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return { id: jobId, state, progress: job.progress, returnvalue: job.returnvalue };
  } catch {
    return null;
  }
}

module.exports = { initQueue, enqueue, getJobStatus, jobEvents };
