// src/api.js
import axios from 'axios';
import API_BASE_URL from './config';

const api = axios.create({ baseURL: API_BASE_URL });

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('jwt');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

export default api;
