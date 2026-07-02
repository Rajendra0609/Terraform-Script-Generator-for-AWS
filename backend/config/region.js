'use strict';
/**
 * Single source of truth for the platform-wide default AWS region.
 *
 * Previously 'ap-south-1' (Mumbai) was hardcoded as a fallback in ~10
 * different places across the backend (DB column defaults, project
 * creation, env/backend-config generators) and the frontend (store
 * defaults, template engine, several panels), baking an India-specific
 * assumption into every global user's new project, cost estimate, and
 * IAM example.
 *
 * Set DEFAULT_AWS_REGION in backend/.env to change it for your deployment.
 * This only affects fallback defaults for *new* projects/resources —
 * existing rows and any explicitly-chosen region are never touched.
 */
const DEFAULT_AWS_REGION = process.env.DEFAULT_AWS_REGION || 'us-east-1';

module.exports = { DEFAULT_AWS_REGION };
