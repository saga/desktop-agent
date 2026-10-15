import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import 'antd/dist/reset.css';
import './styles.css';
import App from './App.js';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#6558d3',
          colorInfo: '#6558d3',
          borderRadius: 12,
          fontFamily: '"Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
          controlHeight: 38,
        },
      }}
    >
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
