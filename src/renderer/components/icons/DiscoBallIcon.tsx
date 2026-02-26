import React from 'react';

interface DiscoBallIconProps {
	className?: string;
	style?: React.CSSProperties;
}

/**
 * Disco ball SVG icon for VIBES branding.
 * Accepts className and style props to match lucide-react icon API.
 */
const DiscoBallIcon: React.FC<DiscoBallIconProps> = ({ className, style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		className={className}
		style={style}
	>
		{/* Main sphere */}
		<circle cx="12" cy="12" r="9" />
		{/* Horizontal bands */}
		<ellipse cx="12" cy="12" rx="9" ry="3" />
		<ellipse cx="12" cy="7" rx="7" ry="2" />
		<ellipse cx="12" cy="17" rx="7" ry="2" />
		{/* Vertical meridian */}
		<ellipse cx="12" cy="12" rx="3" ry="9" />
		{/* Shine facets */}
		<line x1="5" y1="5" x2="6.5" y2="6.5" />
		<line x1="17.5" y1="5" x2="19" y2="3.5" strokeWidth="2" opacity="0.6" />
		<line x1="20" y1="6" x2="21.5" y2="5" strokeWidth="1.5" opacity="0.4" />
	</svg>
);

export default DiscoBallIcon;
