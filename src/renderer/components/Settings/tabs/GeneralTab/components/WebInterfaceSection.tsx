import { Globe2 } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ManagedSettingSection } from '../../../ManagedSettingSection';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

interface WebInterfaceSectionProps {
	theme: Theme;
	webInterfaceAutoStart: boolean;
	setWebInterfaceAutoStart: (enabled: boolean) => void;
}

export function WebInterfaceSection({
	theme,
	webInterfaceAutoStart,
	setWebInterfaceAutoStart,
}: WebInterfaceSectionProps) {
	return (
		<ManagedSettingSection settingId="general-web-interface-auto-start" theme={theme}>
			<SettingsSectionHeading icon={Globe2}>Web Interface</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Turn on web interface at launch"
					description="Automatically make Maestro's full UI available in a browser. Enabling this also turns it on now."
					checked={webInterfaceAutoStart}
					onChange={setWebInterfaceAutoStart}
					ariaLabel="Turn on web interface at launch"
					clickableRow
				/>
			</SectionCard>
		</ManagedSettingSection>
	);
}
