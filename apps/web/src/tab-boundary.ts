import React from 'react';
import {diag} from './diag.ts';

/** 标签页内容出错只替换这一页；App（及其 media/liveness 引用）不卸载，main.tsx 的清理 stop() 不会挂断通话。上报由 createRoot 的 onCaughtError 负责。 */
export class TabBoundary extends React.Component<{children?: React.ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() {return {failed: true};}
  componentDidCatch() {diag.uiError('tab', 'boundary', '该页面出错，请切换标签重试');}
  render() {return this.state.failed ? React.createElement('p', {className: 'error', role: 'alert'}, '该页面出错，请切换标签重试') : this.props.children;}
}
