import { parentPort } from 'node:worker_threads';
import crypto from 'crypto';
import fs from 'fs/promises';
import yaml from 'js-yaml';

import { copyBaseConfigurationFiles, makeLabelForStandaloneApplication, saveBuildLog, setDefaultConfiguration } from '../lib/buildPacks/common';
import { createDirectories, decrypt, defaultComposeConfiguration, executeDockerCmd, getDomain, prisma } from '../lib/common';
import * as importers from '../lib/importers';
import * as buildpacks from '../lib/buildPacks';

(async () => {
	if (parentPort) {
		const concurrency = 1
		const PQueue = await import('p-queue');
		const queue = new PQueue.default({ concurrency });
		parentPort.on('message', async (message) => {
			if (parentPort) {
				if (message === 'error') throw new Error('oops');
				if (message === 'cancel') {
					parentPort.postMessage('cancelled');
					return;
				}
				if (message === 'status:autoUpdater') {
					parentPort.postMessage({ size: queue.size, pending: queue.pending, caller: 'autoUpdater' });
					return;
				}
				if (message === 'status:cleanupStorage') {
					parentPort.postMessage({ size: queue.size, pending: queue.pending, caller: 'cleanupStorage' });
					return;
				}
				if (message === 'action:flushQueue') {
					queue.clear()
					return;
				}

				await queue.add(async () => {
					const {
						id: applicationId,
						repository,
						name,
						destinationDocker,
						destinationDockerId,
						gitSource,
						build_id: buildId,
						configHash,
						fqdn,
						projectId,
						secrets,
						phpModules,
						type,
						pullmergeRequestId = null,
						sourceBranch = null,
						settings,
						persistentStorage,
						pythonWSGI,
						pythonModule,
						pythonVariable,
						denoOptions,
						exposePort,
						baseImage,
						baseBuildImage,
						deploymentType,
						forceRebuild
					} = message
					let {
						branch,
						buildPack,
						port,
						installCommand,
						buildCommand,
						startCommand,
						baseDirectory,
						publishDirectory,
						dockerFileLocation,
						denoMainFile
					} = message
					const currentHash = crypto
						.createHash('sha256')
						.update(
							JSON.stringify({
								pythonWSGI,
								pythonModule,
								pythonVariable,
								deploymentType,
								denoOptions,
								baseImage,
								baseBuildImage,
								buildPack,
								port,
								exposePort,
								installCommand,
								buildCommand,
								startCommand,
								secrets,
								branch,
								repository,
								fqdn
							})
						)
						.digest('hex');
					try {
						const { debug } = settings;
						if (concurrency === 1) {
							await prisma.build.updateMany({
								where: {
									status: { in: ['queued', 'running'] },
									id: { not: buildId },
									applicationId,
									createdAt: { lt: new Date(new Date().getTime() - 10 * 1000) }
								},
								data: { status: 'failed' }
							});
						}
						let imageId = applicationId;
						let domain = getDomain(fqdn);
						const volumes =
							persistentStorage?.map((storage) => {
								return `${applicationId}${storage.path.replace(/\//gi, '-')}:${buildPack !== 'docker' ? '/app' : ''
									}${storage.path}`;
							}) || [];
						// Previews, we need to get the source branch and set subdomain
						if (pullmergeRequestId) {
							branch = sourceBranch;
							domain = `${pullmergeRequestId}.${domain}`;
							imageId = `${applicationId}-${pullmergeRequestId}`;
						}

						let deployNeeded = true;
						let destinationType;

						if (destinationDockerId) {
							destinationType = 'docker';
						}
						if (destinationType === 'docker') {
							await prisma.build.update({ where: { id: buildId }, data: { status: 'running' } });
							const { workdir, repodir } = await createDirectories({ repository, buildId });
							const configuration = await setDefaultConfiguration(message);

							buildPack = configuration.buildPack;
							port = configuration.port;
							installCommand = configuration.installCommand;
							startCommand = configuration.startCommand;
							buildCommand = configuration.buildCommand;
							publishDirectory = configuration.publishDirectory;
							baseDirectory = configuration.baseDirectory;
							dockerFileLocation = configuration.dockerFileLocation;
							denoMainFile = configuration.denoMainFile;
							const commit = await importers[gitSource.type]({
								applicationId,
								debug,
								workdir,
								repodir,
								githubAppId: gitSource.githubApp?.id,
								gitlabAppId: gitSource.gitlabApp?.id,
								customPort: gitSource.customPort,
								repository,
								branch,
								buildId,
								apiUrl: gitSource.apiUrl,
								htmlUrl: gitSource.htmlUrl,
								projectId,
								deployKeyId: gitSource.gitlabApp?.deployKeyId || null,
								privateSshKey: decrypt(gitSource.gitlabApp?.privateSshKey) || null,
								forPublic: gitSource.forPublic
							});
							if (!commit) {
								throw new Error('No commit found?');
							}
							let tag = commit.slice(0, 7);
							if (pullmergeRequestId) {
								tag = `${commit.slice(0, 7)}-${pullmergeRequestId}`;
							}

							try {
								await prisma.build.update({ where: { id: buildId }, data: { commit } });
							} catch (err) {
								console.log(err);
							}

							if (!pullmergeRequestId) {

								if (configHash !== currentHash) {
									deployNeeded = true;
									if (configHash) {
										await saveBuildLog({ line: 'Configuration changed.', buildId, applicationId });
									}
								} else {
									deployNeeded = false;
								}
							} else {
								deployNeeded = true;
							}

							let imageFound = false;
							try {
								await executeDockerCmd({
									dockerId: destinationDocker.id,
									command: `docker image inspect ${applicationId}:${tag}`
								})
								imageFound = true;
							} catch (error) {
								//
							}
							await copyBaseConfigurationFiles(buildPack, workdir, buildId, applicationId, baseImage);

							if (forceRebuild) deployNeeded = true
							if (!imageFound || deployNeeded) {
								// if (true) {
								if (buildpacks[buildPack])
									await buildpacks[buildPack]({
										dockerId: destinationDocker.id,
										buildId,
										applicationId,
										domain,
										name,
										type,
										pullmergeRequestId,
										buildPack,
										repository,
										branch,
										projectId,
										publishDirectory,
										debug,
										commit,
										tag,
										workdir,
										port: exposePort ? `${exposePort}:${port}` : port,
										installCommand,
										buildCommand,
										startCommand,
										baseDirectory,
										secrets,
										phpModules,
										pythonWSGI,
										pythonModule,
										pythonVariable,
										dockerFileLocation,
										denoMainFile,
										denoOptions,
										baseImage,
										baseBuildImage,
										deploymentType
									});
								else {
									await saveBuildLog({ line: `Build pack ${buildPack} not found`, buildId, applicationId });
									throw new Error(`Build pack ${buildPack} not found.`);
								}
							} else {
								await saveBuildLog({ line: 'Build image already available - no rebuild required.', buildId, applicationId });
							}
							try {
								await executeDockerCmd({ dockerId: destinationDocker.id, command: `docker stop -t 0 ${imageId}` })
								await executeDockerCmd({ dockerId: destinationDocker.id, command: `docker rm ${imageId}` })
							} catch (error) {
								//
							}
							const envs = [
								`PORT=${port}`
							];
							if (secrets.length > 0) {
								secrets.forEach((secret) => {
									if (pullmergeRequestId) {
										if (secret.isPRMRSecret) {
											envs.push(`${secret.name}=${secret.value}`);
										}
									} else {
										if (!secret.isPRMRSecret) {
											envs.push(`${secret.name}=${secret.value}`);
										}
									}
								});
							}
							await fs.writeFile(`${workdir}/.env`, envs.join('\n'));
							const labels = makeLabelForStandaloneApplication({
								applicationId,
								fqdn,
								name,
								type,
								pullmergeRequestId,
								buildPack,
								repository,
								branch,
								projectId,
								port: exposePort ? `${exposePort}:${port}` : port,
								commit,
								installCommand,
								buildCommand,
								startCommand,
								baseDirectory,
								publishDirectory
							});
							let envFound = false;
							try {
								envFound = !!(await fs.stat(`${workdir}/.env`));
							} catch (error) {
								//
							}
							try {
								await saveBuildLog({ line: 'Deployment started.', buildId, applicationId });
								const composeVolumes = volumes.map((volume) => {
									return {
										[`${volume.split(':')[0]}`]: {
											name: volume.split(':')[0]
										}
									};
								});
								const composeFile = {
									version: '3.8',
									services: {
										[imageId]: {
											image: `${applicationId}:${tag}`,
											container_name: imageId,
											volumes,
											env_file: envFound ? [`${workdir}/.env`] : [],
											labels,
											depends_on: [],
											expose: [port],
											...(exposePort ? { ports: [`${exposePort}:${port}`] } : {}),
											// logging: {
											// 	driver: 'fluentd',
											// },
											...defaultComposeConfiguration(destinationDocker.network),
										}
									},
									networks: {
										[destinationDocker.network]: {
											external: true
										}
									},
									volumes: Object.assign({}, ...composeVolumes)
								};
								await fs.writeFile(`${workdir}/docker-compose.yml`, yaml.dump(composeFile));
								await executeDockerCmd({ dockerId: destinationDocker.id, command: `docker compose --project-directory ${workdir} up -d` })
								await saveBuildLog({ line: 'Deployment successful!', buildId, applicationId });
							} catch (error) {
								await saveBuildLog({ line: error, buildId, applicationId });
								await prisma.build.updateMany({
									where: { id: message.build_id, status: { in: ['queued', 'running'] } },
									data: { status: 'failed' }
								});
								throw new Error(error);
							}
							await saveBuildLog({ line: 'Proxy will be updated shortly.', buildId, applicationId });
							await prisma.build.update({ where: { id: message.build_id }, data: { status: 'success' } });
							if (!pullmergeRequestId) await prisma.application.update({
								where: { id: applicationId },
								data: { configHash: currentHash }
							});
						}

					}
					catch (error) {
						await prisma.build.updateMany({
							where: { id: message.build_id, status: { in: ['queued', 'running'] } },
							data: { status: 'failed' }
						});
						await saveBuildLog({ line: error, buildId, applicationId });
					} finally {
						await prisma.$disconnect();
					}
				});
				await prisma.$disconnect();
			}
		});
	} else process.exit(0);
})();
