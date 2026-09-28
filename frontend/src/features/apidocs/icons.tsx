// The code panel's tab icons: the brands' own marks as small PNGs (64 px, shown at 16 px).
// apidocs.css greys them out unless their tab is chosen.
import React from 'react';
import curl from './icons/curl.png?no-inline';
import node from './icons/node.png?no-inline';
import playwright from './icons/playwright.png?no-inline';
import selenium from './icons/selenium.png?no-inline';

const icon = (src: string): React.FC => {
  const Icon: React.FC = () => <img src={src} width={16} height={16} alt="" aria-hidden="true" draggable={false} />;
  return Icon;
};

export const CurlIcon = icon(curl);
export const NodeIcon = icon(node);
export const SeleniumIcon = icon(selenium);
export const PlaywrightIcon = icon(playwright);
