import React, { useEffect, useState, useRef } from 'react';

export const NeonCyberCursor: React.FC = () => {
  const dotWrapperRef = useRef<HTMLDivElement>(null);
  const ringWrapperRef = useRef<HTMLDivElement>(null);

  const [isHovered, setIsHovered] = useState(false);
  const [isClicked, setIsClicked] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const mousePos = useRef({ x: -200, y: -200 });
  const ringPos = useRef({ x: -200, y: -200 });
  const animFrameId = useRef<number | null>(null);

  useEffect(() => {
    // Only run on mouse-driven pointing devices
    if (window.matchMedia('(pointer: coarse)').matches) {
      return;
    }

    const onMouseMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
      if (!isVisible) setIsVisible(true);

      const target = e.target as HTMLElement | null;
      if (target) {
        const interactive = target.closest(
          'button, a, input, select, textarea, [role="button"], tr, .btn, .nav-tab, .resource-card, .metric-card, .badge, .status-badge, .search-box, label'
        );
        setIsHovered(Boolean(interactive));
      }
    };

    const onMouseDown = () => setIsClicked(true);
    const onMouseUp = () => setIsClicked(false);
    const onMouseLeave = () => setIsVisible(false);
    const onMouseEnter = () => setIsVisible(true);

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('mouseenter', onMouseEnter);

    // Lightweight 120 FPS render loop
    const animate = () => {
      if (dotWrapperRef.current) {
        dotWrapperRef.current.style.transform = `translate3d(${mousePos.current.x}px, ${mousePos.current.y}px, 0)`;
      }

      const ease = isHovered ? 0.35 : 0.25;
      ringPos.current.x += (mousePos.current.x - ringPos.current.x) * ease;
      ringPos.current.y += (mousePos.current.y - ringPos.current.y) * ease;

      if (ringWrapperRef.current) {
        ringWrapperRef.current.style.transform = `translate3d(${ringPos.current.x}px, ${ringPos.current.y}px, 0)`;
      }

      animFrameId.current = requestAnimationFrame(animate);
    };

    animFrameId.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('mouseenter', onMouseEnter);
      if (animFrameId.current) cancelAnimationFrame(animFrameId.current);
    };
  }, [isVisible, isHovered]);

  if (!isVisible) return null;

  return (
    <div className="minimal-cursor-layer" aria-hidden="true">
      {/* Sleek Outer Emerald Ring */}
      <div ref={ringWrapperRef} className="cursor-pos-wrapper">
        <div
          className={`minimal-cursor-ring ${isHovered ? 'hovered' : ''} ${
            isClicked ? 'clicked' : ''
          }`}
        />
      </div>

      {/* Sharp Precision Center Dot */}
      <div ref={dotWrapperRef} className="cursor-pos-wrapper">
        <div
          className={`minimal-cursor-dot ${isHovered ? 'hovered' : ''} ${
            isClicked ? 'clicked' : ''
          }`}
        />
      </div>
    </div>
  );
};


