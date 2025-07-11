// File: src/config.js

// Try to read the Amplify‐injected REACT_APP_API_BASE_URL first,
// otherwise fall back to your new EB endpoint:
const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL ||
  'https://fcgg.us-east-2.elasticbeanstalk.com';

export default API_BASE_URL;
