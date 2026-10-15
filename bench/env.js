import os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Gathers system hardware, runtime environment, and git tracking metadata
 * for reproducible benchmark reporting.
 */
export function getBenchmarkEnv() {
  let gitCommit = 'unknown';
  let gitDirty = false;

  try {
    gitCommit = execSync('git rev-parse HEAD', { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const statusOutput = execSync('git status --porcelain', {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    gitDirty = statusOutput.length > 0;
  } catch {
    // Git metadata unavailable (e.g. non-git environment)
  }

  const cpus = os.cpus();
  const cpuModel = cpus && cpus[0] ? cpus[0].model.trim() : 'Unknown CPU';
  const cpuCount = cpus ? cpus.length : 1;
  const totalMem = os.totalmem();

  return {
    node_version: process.version,
    cpu_model: cpuModel,
    cpu_count: cpuCount,
    total_memory_bytes: totalMem,
    total_memory_gb: Number((totalMem / 1024 ** 3).toFixed(2)),
    os_type: os.type(),
    os_platform: os.platform(),
    os_release: os.release(),
    os_arch: os.arch(),
    git_commit: gitCommit,
    git_dirty: gitDirty,
    thermal_throttling_note:
      'Fanless laptop architecture (Apple Silicon); prolonged execution is susceptible to thermal throttling. Repetitions (>= 5 runs) report median and spread (max - min) to mitigate transient frequency scaling.',
  };
}

/**
 * Calculates descriptive statistics including median, percentiles, and spread.
 * @param {number[]} numbers - Array of numeric measurements.
 * @returns {object} Statistics summary.
 */
export function computeStats(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      spread: 0,
      stddev: 0,
    };
  }

  const sorted = [...numbers].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0];
  const max = sorted[count - 1];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / count;

  const getPercentile = p => {
    if (count === 1) return sorted[0];
    const index = (p / 100) * (count - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  const p50 = getPercentile(50);
  const p95 = getPercentile(95);
  const p99 = getPercentile(99);
  const median = p50;
  const spread = max - min;

  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);

  return {
    count,
    min,
    max,
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    p50: Number(p50.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    p99: Number(p99.toFixed(2)),
    spread: Number(spread.toFixed(2)),
    stddev: Number(stddev.toFixed(2)),
  };
}
