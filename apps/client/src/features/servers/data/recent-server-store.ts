import AsyncStorage from '@react-native-async-storage/async-storage';
import { RecentServerStore } from '@signaldock/client-sdk';

export const recentServerStore = new RecentServerStore(AsyncStorage);
