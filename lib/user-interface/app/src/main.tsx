import "regenerator-runtime/runtime";
// Loads Bootstrap (LTR or RTL build based on stored language) and sets the
// document direction. Must stay before the other style imports so custom CSS
// keeps winning the cascade.
import "./common/direction";
import React from "react";
import ReactDOM from "react-dom/client";
import AppConfigured from "./components/app-configured";
import { StorageHelper } from "./common/helpers/storage-helper";
import './styles/app.scss';
import './styles/modal.css';
import './styles/buttons.css';
import './styles/rtl.css';

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

const theme = StorageHelper.getTheme();
StorageHelper.applyTheme(theme);

root.render(
  <React.StrictMode>
    <AppConfigured />
  </React.StrictMode>
);