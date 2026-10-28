import {
  Component,
  createContext,
  useContext,
  type PropsWithChildren,
} from 'react';
import { View } from 'react-native';
import { ErrorState } from './primitives';
import { space } from './tokens';
const ScreenActivity = createContext(true);
export const useScreenActive = () => useContext(ScreenActivity);
class ScreenBoundary extends Component<
  PropsWithChildren,
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <View style={{ padding: space.lg }}>
          <ErrorState
            message="This view could not be displayed. Try loading it again."
            onRetry={() =>
              this.setState(({ attempt }) => ({
                failed: false,
                attempt: attempt + 1,
              }))
            }
          />
        </View>
      );
    return (
      <View key={this.state.attempt} style={{ flex: 1 }}>
        {this.props.children}
      </View>
    );
  }
}
/** Retains form/filter state while allowing media to suspend when a destination is hidden. */
export function FeatureView({
  active,
  children,
}: PropsWithChildren<{ active: boolean }>) {
  return (
    <ScreenActivity.Provider value={active}>
      <View style={{ flex: 1, display: active ? 'flex' : 'none' }}>
        <ScreenBoundary>{children}</ScreenBoundary>
      </View>
    </ScreenActivity.Provider>
  );
}
