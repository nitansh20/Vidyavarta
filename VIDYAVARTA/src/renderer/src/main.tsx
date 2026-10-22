import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CampusApp } from './campus/CampusApp';
const root=createRoot(document.getElementById('root')!);
root.render(<StrictMode><CampusApp/></StrictMode>);
