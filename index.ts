import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// Register Service Worker for PWA support
if (Platform.OS === 'web' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.log('SW registration failed:', err);
    });
  });
}
