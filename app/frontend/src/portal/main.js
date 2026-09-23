import { createApp } from 'vue';
import '../styles/global.css';
import PortalApp from './PortalApp.vue';
import { vReveal } from '../lib/api';

createApp(PortalApp).directive('reveal', vReveal).mount('#app');
