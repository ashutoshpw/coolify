<script context="module" lang="ts">
	import type { Load } from '@sveltejs/kit';
	export const load: Load = async ({ stuff }) => {
		return {
			props: { ...stuff }
		};
	};
</script>

<script lang="ts">
	import { page } from '$app/stores';
	import { get } from '$lib/api';
	import { onDestroy, onMount } from 'svelte';
	import DatabaseLinks from './_DatabaseLinks.svelte';
	import Databases from './_Databases/_Databases.svelte';
	import { status } from '$lib/store';
	export let database: any;
	export let privatePort: any;

	const { id } = $page.params;
	let loading = {
		usage: false
	};
	let usage = {
		MemUsage: 0,
		CPUPerc: 0,
		NetIO: 0
	};
	let usageInterval: any;

	async function getUsage() {
		if (loading.usage) return;
		if (!$status.database.isRunning) return;
		loading.usage = true;
		const data = await get(`/databases/${id}/usage`);
		usage = data.usage;
		loading.usage = false;
	}

	onDestroy(() => {
		clearInterval(usageInterval);
	});
	onMount(async () => {
		await getUsage();
		usageInterval = setInterval(async () => {
			await getUsage();
		}, 1500);
	});
</script>

<div class="flex h-20 items-center space-x-2 p-5 px-6 font-bold">
	<div class="-mb-5 flex-col">
		<div class="md:max-w-64 truncate text-base tracking-tight md:text-2xl lg:block">
			Configuration
		</div>
		<span class="text-xs">{database.name}</span>
	</div>
	<DatabaseLinks {database} />
</div>

<div class="mx-auto max-w-4xl px-6 py-4">
	<div class="text-2xl font-bold">Database Usage</div>
	<div class="text-center">
		<div class="stat w-64">
			<div class="stat-title">Used Memory / Memory Limit</div>
			<div class="stat-value text-xl">{usage?.MemUsage}</div>
		</div>

		<div class="stat w-64">
			<div class="stat-title">Used CPU</div>
			<div class="stat-value text-xl">{usage?.CPUPerc}</div>
		</div>

		<div class="stat w-64">
			<div class="stat-title">Network IO</div>
			<div class="stat-value text-xl">{usage?.NetIO}</div>
		</div>
	</div>
</div>
<Databases bind:database {privatePort} />
