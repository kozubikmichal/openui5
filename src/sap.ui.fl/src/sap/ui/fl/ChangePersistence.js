/*!
 * ${copyright}
 */

sap.ui.define([
	"sap/ui/fl/Change", "sap/ui/fl/Utils", "sap/ui/fl/LrepConnector", "sap/ui/fl/Cache", "sap/ui/fl/context/ContextManager", "sap/ui/fl/registry/Settings", "sap/ui/fl/variants/VariantController"
], function(Change, Utils, LRepConnector, Cache, ContextManager, Settings, VariantController) {
	"use strict";

	/**
	 * Helper object to access a change from the back end. Access helper object for each change (and variant) which was fetched from the back end
	 *
	 * @constructor
	 * @author SAP SE
	 * @version 1.37.0-SNAPSHOT
	 * @experimental Since 1.25.0
	 * @param {object} mComponent - Component data to initiate <code>ChangePersistence</code> instance
	 * @param {string} mComponent.name - Name of the component this instance is responsible for
	 * @param {string} mComponent.appVersion - Version of application
	 */
	var ChangePersistence = function(mComponent) {
		this._mComponent = mComponent;
		//_mChanges contains:
		// - mChanges: map of changes (selector id)
		// - mDependencies: map of changes (change key) that need to be applied before any change. Used to check if a change can be applied. Format:
		//		mDependencies: {
		//			"fileNameChange2USERnamespace": {
		//				"changeObject": oChange2,
		//				"dependencies": ["fileNameChange1USERnamespace"]
		//			},
		//			"fileNameChange3USERnamespace": {
		//				"changeObject": oChange3,
		//				"dependencies": ["fileNameChange2USERnamespace"]
		//			}
		//		}
		// - mDependentChangesOnMe: map of changes (change key) that cannot be applied before the change. Used to remove dependencies faster. Format:
		//		mDependentChangesOnMe: {
		//			"fileNameChange1USERnamespace": [oChange2],
		//			"fileNameChange2USERnamespace": [oChange3]
		//		}
		this._mChanges = {
			mChanges: {},
			mDependencies: {},
			mDependentChangesOnMe: {}
		};

		if (!this._mComponent || !this._mComponent.name) {
			Utils.log.error("The Control does not belong to an SAPUI5 component. Personalization and changes for this control might not work as expected.");
			throw new Error("Missing component name.");
		}

		this._oVariantController = new VariantController(this._mComponent.name, this._mComponent.appVersion, {});
		this._oConnector = this._createLrepConnector();
		this._aDirtyChanges = [];
	};

	ChangePersistence.NOTAG = "<NoTag>";

	/**
	 * Return the name of the SAPUI5 component. All changes are assigned to 1 SAPUI5 component. The SAPUI5 component also serves as authorization
	 * object.
	 *
	 * @returns {String} component name
	 * @public
	 */
	ChangePersistence.prototype.getComponentName = function() {
		return this._mComponent.name;
	};

	/**
	 * Creates a new instance of the LRepConnector
	 *
	 * @returns {sap.ui.fl.LrepConnector} LRep connector instance
	 * @private
	 */
	ChangePersistence.prototype._createLrepConnector = function() {
		return LRepConnector.createConnector();
	};


	ChangePersistence.prototype.getCacheKey = function() {
		return Cache.getChangesFillingCache(this._oConnector, this._mComponent).then(function(oWrappedChangeFileContent) {
			if (oWrappedChangeFileContent && oWrappedChangeFileContent.etag) {
				return oWrappedChangeFileContent.etag;
			}

			return ChangePersistence.NOTAG;
		});
	};

	/**
	 * Verifies whether a change fulfils the preconditions.
	 *
	 * All changes need to be matched with current active contexts;
	 * only changes whose <code>fileType</code> is 'change' and whose <code>changeType</code> is different from 'defaultVariant' are valid;
	 * if <code>bIncludeVariants</code> parameter is true, the changes with 'variant' <code>fileType</code> or 'defaultVariant' <code>changeType</code> are also valid
	 * if it has a selector <code>persistencyKey</code>.
	 *
	 * @param {sap.ui.fl.context.Context[]} aActiveContexts - Array of current active contexts
	 * @param {boolean} [bIncludeVariants] - Indicates that smart variants shall be included
	 * @param {object} oChangeContent - Content of the change
	 *
	 * @returns {boolean} <code>true</code> if all the preconditions are fulfilled
	 * @public
	 */
	ChangePersistence.prototype._preconditionsFulfilled = function(aActiveContexts, bIncludeVariants, oChangeContent) {

		function _isValidFileType () {
			if (bIncludeVariants) {
				return (oChangeContent.fileType === "change") || (oChangeContent.fileType === "variant");
			}
			return (oChangeContent.fileType === "change") && (oChangeContent.changeType !== "defaultVariant");
		}

		function _isValidSelector () {
			if (bIncludeVariants) {
				if ((oChangeContent.fileType === "variant") || (oChangeContent.changeType === "defaultVariant")){
					return oChangeContent.selector && oChangeContent.selector.persistencyKey;
				}
			}
			return true;
		}

		function _isValidContext () {
			return ContextManager.doesContextMatch(oChangeContent, aActiveContexts);
		}

		if (_isValidFileType() && _isValidSelector() && _isValidContext()){
				return true;
		}
		return false;
	};

	/**
	 * Calls the back end asynchronously and fetches all changes for the component
	 * New changes (dirty state) that are not yet saved to the back end won't be returned.
	 * @param {map} mPropertyBag - Contains additional data needed for reading changes
	 * @param {object} mPropertyBag.appDescriptor - Manifest that belongs to actual component
	 * @param {string} mPropertyBag.siteId - ID of the site belonging to actual component
	 * @param {string} [mPropertyBag.sCurrentLayer] - Specifies a single layer for loading changes. If this parameter is set, the max layer filtering is not applied
	 * @param {boolean} [mPropertyBag.ignoreMaxLayerParameter] - Indicates that changes shall be loaded without layer filtering
	 * @param {boolean} [mPropertyBag.includeVariants] - Indicates that smart variants shall be included
	 * @param {string} [mPropertyBag.cacheKey] - key to validate the client side stored cache entry
	 * @param {string} [mPropertyBag.url] - address to which the request for change should be sent in case the data is not cached
	 * @see sap.ui.fl.Change
	 * @returns {Promise} Resolving with an array of changes
	 * @public
	 */
	ChangePersistence.prototype.getChangesForComponent = function(mPropertyBag) {
		return Cache.getChangesFillingCache(this._oConnector, this._mComponent, mPropertyBag).then(function(oWrappedChangeFileContent) {
			this._bHasLoadedChangesFromBackEnd = true;

			if (oWrappedChangeFileContent.changes && oWrappedChangeFileContent.changes.settings){
				Settings._storeInstance(oWrappedChangeFileContent.changes.settings);
			}

			if (!oWrappedChangeFileContent.changes || !oWrappedChangeFileContent.changes.changes) {
				return [];
			}

			var aChanges = oWrappedChangeFileContent.changes.changes;

			if (oWrappedChangeFileContent.changes.variantSection && oWrappedChangeFileContent.changes.variantSection !== {}) {
				this._oVariantController._setChangeFileContent(oWrappedChangeFileContent);
				var aVariantChanges = this._oVariantController.loadDefaultChanges();
				aChanges = aChanges.concat(aVariantChanges);
			}

			var sCurrentLayer = mPropertyBag && mPropertyBag.currentLayer;
			if (sCurrentLayer) {
				var aCurrentLayerChanges = [];
				aChanges.forEach(function (oChange) {
					if (oChange.layer === sCurrentLayer) {
						aCurrentLayerChanges.push(oChange);
					}
				});
				aChanges = aCurrentLayerChanges;
			} else if (Utils.isLayerFilteringRequired() && !(mPropertyBag && mPropertyBag.ignoreMaxLayerParameter)) {
				//If layer filtering required, excludes changes in higher layer than the max layer
				var aFilteredChanges = [];
				aChanges.forEach(function (oChange) {
					if (!Utils.isOverMaxLayer(oChange.layer)) {
						aFilteredChanges.push(oChange);
					}
				});
				aChanges = aFilteredChanges;
			}

			var bIncludeVariants = mPropertyBag && mPropertyBag.includeVariants;

			var aContextObjects = oWrappedChangeFileContent.changes.contexts || [];
			return new Promise(function (resolve) {
				ContextManager.getActiveContexts(aContextObjects).then(function (aActiveContexts) {
					resolve(aChanges.filter(this._preconditionsFulfilled.bind(this, aActiveContexts, bIncludeVariants)).map(createChange));
				}.bind(this));
			}.bind(this));

		}.bind(this));

		function createChange(oChangeContent) {
			var change = new Change(oChangeContent);
			change.setState(Change.states.PERSISTED);
			return change;
		}
	};

	/**
	 * @param {sap.ui.core.UIComponent} oComponent - component containing the control for which the change should be added
	 * @param {sap.ui.fl.Change} oChange - change which should be added into the mapping
	 * @see sap.ui.fl.Change
	 * @returns {map} mChanges - map with added change
	 * @private
	 */
	ChangePersistence.prototype._addChangeIntoMap = function (oComponent, oChange) {
		var oSelector = oChange.getSelector();
		if (oSelector && oSelector.id) {
			var sSelectorId = oSelector.id;
			if (oSelector.idIsLocal) {
				sSelectorId = oComponent.createId(sSelectorId);
			}

			this._addMapEntry(sSelectorId, oChange);

			// if the localId flag is missing and the selector has a component prefix that is not matching the
			// application component, adds the change for a second time replacing the component ID prefix with
			// the application component ID prefix
			if (oSelector.idIsLocal === undefined && sSelectorId.indexOf("---") != -1) {
				var sComponentPrefix = sSelectorId.split("---")[0];

				if (sComponentPrefix !== oComponent.getId()) {
					sSelectorId = sSelectorId.split("---")[1];
					sSelectorId = oComponent.createId(sSelectorId);
					this._addMapEntry(sSelectorId, oChange);
				}
			}
		}

		return this._mChanges;
	};

	/**
	 *
	 * @param {string} sSelectorId Key in the mapping for which the entry is written
	 * @param {sap.ui.fl.Change} oChange Change object to be added to the mapping
	 * @private
	 */
	ChangePersistence.prototype._addMapEntry = function (sSelectorId, oChange) {
		if (!this._mChanges.mChanges[sSelectorId]) {
			this._mChanges.mChanges[sSelectorId] = [];
		}
		this._mChanges.mChanges[sSelectorId].push(oChange);
	};

	ChangePersistence.prototype._addDependency = function (oDependentChange, oChange) {
		if (!this._mChanges.mDependencies[oDependentChange.getKey()]) {
			this._mChanges.mDependencies[oDependentChange.getKey()] = {
				changeObject: oDependentChange,
				dependencies: []
			};
		}
		this._mChanges.mDependencies[oDependentChange.getKey()].dependencies.push(oChange.getKey());

		if (!this._mChanges.mDependentChangesOnMe[oChange.getKey()]) {
			this._mChanges.mDependentChangesOnMe[oChange.getKey()] = [];
		}
		this._mChanges.mDependentChangesOnMe[oChange.getKey()].push(oDependentChange.getKey());
	};

	ChangePersistence.prototype._addControlsDependencies = function (oDependentChange, aControlIdList) {
		if (aControlIdList.length > 0) {
			if (!this._mChanges.mDependencies[oDependentChange.getKey()]) {
				this._mChanges.mDependencies[oDependentChange.getKey()] = {
					changeObject: oDependentChange,
					dependencies: [],
					controlsDependencies: []
				};
			}
			this._mChanges.mDependencies[oDependentChange.getKey()].controlsDependencies = aControlIdList;
		}
	};

	/**
	 * Calls the back end asynchronously and fetches all changes for the component
	 * New changes (dirty state) that are not yet saved to the back end won't be returned.
	 * @param {object} oComponent - Component instance used to prepare the IDs (e.g. local)
	 * @param {map} mPropertyBag - Contains additional data needed for reading changes
	 * @param {object} mPropertyBag.appDescriptor - Manifest belonging to actual component
	 * @param {string} mPropertyBag.siteId - ID of the site belonging to actual component
	 * @see sap.ui.fl.Change
	 * @returns {Promise} Resolving with a getter for the changes map
	 * @public
	 */
	ChangePersistence.prototype.loadChangesMapForComponent = function (oComponent, mPropertyBag) {

		return this.getChangesForComponent(mPropertyBag).then(createChangeMap.bind(this));

		function createChangeMap(aChanges) {
			//Since starting RTA does not recreate ChangePersistence instance, resets changes map is required to filter personalized changes
			this._mChanges = {
				mChanges: {},
				mDependencies: {},
				mDependentChangesOnMe: {}
			};
			aChanges.forEach(this._addChangeAndUpdateDependencies.bind(this, oComponent));

			return this.getChangesMapForComponent.bind(this);
		}
	};

	ChangePersistence.prototype._addChangeAndUpdateDependencies = function(oComponent, oChange, iIndex, aChangesCopy) {
		this._addChangeIntoMap(oComponent, oChange);

		var oAppComponent = Utils.getAppComponentForControl(oComponent);

		//create dependencies map
		var aDependentIdList = oChange.getDependentIdList(oAppComponent);
		var aDependentControlIdList = oChange.getDependentControlIdList(oAppComponent);
		this._addControlsDependencies(oChange, aDependentControlIdList);
		var oPreviousChange;
		var aPreviousDependentIdList;
		var iDependentIndex;
		var bFound;

		for (var i = iIndex - 1; i >= 0; i--) {//loop over the changes
			oPreviousChange = aChangesCopy[i];
			aPreviousDependentIdList = aChangesCopy[i].getDependentIdList(oAppComponent);
			bFound = false;
			for (var j = 0; j < aDependentIdList.length && !bFound; j++) {
				iDependentIndex = aPreviousDependentIdList.indexOf(aDependentIdList[j]);
				if (iDependentIndex > -1) {
					this._addDependency(oChange, oPreviousChange);
					bFound = true;
				}
			}
		}

	};

	/**
	 * Getter for the private aggregation containing sap.ui.fl.Change objects mapped by their selector ids.
	 * @return {map} mChanges mapping with changes sorted by their selector ids
	 * @public
	 */
	ChangePersistence.prototype.getChangesMapForComponent = function () {
		return this._mChanges;
	};

	/**
	 * Gets the changes for the given view id. The complete view prefix has to match.
	 *
	 * Example:
	 * Change has selector id:
	 * view1--view2--controlId
	 *
	 * Will match for view:
	 * view1--view2
	 *
	 * Will not match for view:
	 * view1
	 * view1--view2--view3
	 *
	 * @param {string} sViewId - the id of the view, changes should be retrieved for
	 * @param {map} mPropertyBag - contains additional data that are needed for reading of changes
	 * @param {object} mPropertyBag.appDescriptor - Manifest that belongs to actual component
	 * @param {string} mPropertyBag.siteId - id of the site that belongs to actual component
	 * @returns {Promise} resolving with an array of changes
	 * @public
	 */
	ChangePersistence.prototype.getChangesForView = function(sViewId, mPropertyBag) {
		var that = this;
		return this.getChangesForComponent(mPropertyBag).then(function(aChanges) {
			return aChanges.filter(changesHavingCorrectViewPrefix.bind(that));
		});

		function changesHavingCorrectViewPrefix(oChange) {
			var oSelector = oChange.getSelector();
			if (!oSelector){
				return false;
			}
			var sSelectorId = oSelector.id;
			if (!sSelectorId || !mPropertyBag) {
				return false;
			}
			var sSelectorIdViewPrefix = sSelectorId.slice(0, sSelectorId.lastIndexOf("--"));
			var sViewId;

			if (oChange.getSelector().idIsLocal) {
				var oAppComponent = mPropertyBag.appComponent;
				if (oAppComponent) {
					sViewId = oAppComponent.getLocalId(mPropertyBag.viewId);
				}
			} else {
				sViewId = mPropertyBag.viewId;
			}

			return sSelectorIdViewPrefix === sViewId;
		}
	};

	/**
	 * Adds a new change (could be variant as well) and returns the id of the new change.
	 *
	 * @param {object} vChange - The complete and finalized JSON object representation the file content of the change or a Change instance
	 * @param {object} oComponent Component instance
	 * @returns {sap.ui.fl.Change} the newly created change object
	 * @public
	 */
	ChangePersistence.prototype.addChange = function(vChange, oComponent) {
		var oNewChange;
		if (vChange instanceof Change){
			oNewChange = vChange;
		}else {
			oNewChange = new Change(vChange);
		}
		this._aDirtyChanges.push(oNewChange);
		this._addChangeIntoMap(oComponent, oNewChange);
		this._addPropagationListener(oComponent);


		return oNewChange;
	};

	/**
	 * If the first changes were created, the <code>propagationListener</code> of <code>sap.ui.fl</code> might not yet
	 * be attached to the application component and must be added then.
	 *
	 * @param {sap.ui.core.UiComponent} oComponent Application component that might not have a propagation listener yet
	 * @private
	 */
	ChangePersistence.prototype._addPropagationListener = function (oComponent) {
		if (oComponent) {
			var fnCheckIsNotFlPropagationListener = function (fnPropagationListener) {
				return !fnPropagationListener._bIsSapUiFlFlexControllerApplyChangesOnControl;
			};
			var bNoFlPropagationListenerAttached = oComponent.getPropagationListeners().every(fnCheckIsNotFlPropagationListener);

			if (bNoFlPropagationListenerAttached) {
				var oManifest = oComponent.getManifest();
				var sVersion = Utils.getAppVersionFromManifest(oManifest);
				var oFlexController = sap.ui.fl.FlexControllerFactory.create(this.getComponentName(), sVersion);
				var fnPropagationListener = oFlexController.getBoundApplyChangesOnControl(this.getChangesMapForComponent.bind(this), oComponent);
				oComponent.addPropagationListener(fnPropagationListener);
			}
		}
	};

	/**
	 * Saves all dirty changes by calling the appropriate back-end method (create for new changes, deleteChange for deleted changes);
	 * to ensure the correct order, the methods are called sequentially;
	 * after a change was saved successfully, it is removed from the dirty changes and the cache is updated.
	 *
	 * @returns {Promise} resolving after all changes have been saved
	 */
	ChangePersistence.prototype.saveDirtyChanges = function() {
		var aDirtyChangesClone = this._aDirtyChanges.slice(0);
		var aDirtyChanges = this._aDirtyChanges;
		var aRequests = this._getRequests(aDirtyChangesClone);
		var aPendingActions = this._getPendingActions(aDirtyChangesClone);

		if (aPendingActions.length === 1 && aRequests.length === 1 && aPendingActions[0] === "NEW") {
			var sRequest = aRequests[0];
			var aPreparedDirtyChangesBulk = this._prepareDirtyChanges(aDirtyChanges);
			return this._oConnector.create(aPreparedDirtyChangesBulk, sRequest).then(this._massUpdateCacheAndDirtyState(aDirtyChanges, aDirtyChangesClone));
		} else {
			return aDirtyChangesClone.reduce(function (sequence, oDirtyChange) {
				var saveAction = sequence.then(this._performSingleSaveAction(oDirtyChange).bind(this));
				saveAction.then(this._updateCacheAndDirtyState(aDirtyChanges, oDirtyChange));

				return saveAction;
			}.bind(this), Promise.resolve());
		}
	};

	ChangePersistence.prototype._performSingleSaveAction = function (oDirtyChange) {
		return function() {
			if (oDirtyChange.getPendingAction() === "NEW") {
				return this._oConnector.create(oDirtyChange.getDefinition(), oDirtyChange.getRequest());
			}

			if (oDirtyChange.getPendingAction() === "DELETE") {
				return this._oConnector.deleteChange({
					sChangeName: oDirtyChange.getId(),
					sLayer: oDirtyChange.getLayer(),
					sNamespace: oDirtyChange.getNamespace(),
					sChangelist: oDirtyChange.getRequest()
				});
			}
		};
	};

	ChangePersistence.prototype._updateCacheAndDirtyState = function (aDirtyChanges, oDirtyChange) {
		var that = this;

		return function() {
			if (oDirtyChange.getPendingAction() === "NEW") {
				Cache.addChange(that._mComponent, oDirtyChange.getDefinition());
			}

			if (oDirtyChange.getPendingAction() === "DELETE") {
				Cache.deleteChange(that._mComponent, oDirtyChange.getDefinition());
			}

			var iIndex = aDirtyChanges.indexOf(oDirtyChange);
			if (iIndex > -1) {
				aDirtyChanges.splice(iIndex, 1);
			}
		};
	};

	ChangePersistence.prototype._massUpdateCacheAndDirtyState = function (aDirtyChanges, aDirtyChangesClone) {
		var that = this;

		jQuery.each(aDirtyChangesClone, function (index, oDirtyChange) {
			that._updateCacheAndDirtyState(aDirtyChanges, oDirtyChange)();
		});
	};

	ChangePersistence.prototype._getRequests = function (aDirtyChanges) {
		var aRequests = [];

		jQuery.each(aDirtyChanges, function (index, oChange) {
			var sRequest = oChange.getRequest();
			if (aRequests.indexOf(sRequest) === -1) {
				aRequests.push(sRequest);
			}
		});

		return aRequests;
	};

	ChangePersistence.prototype._getPendingActions = function (aDirtyChanges) {
		var aPendingActions = [];

		jQuery.each(aDirtyChanges, function (index, oChange) {
			var sPendingAction = oChange.getPendingAction();
			if (aPendingActions.indexOf(sPendingAction) === -1) {
				aPendingActions.push(sPendingAction);
			}
		});

		return aPendingActions;
	};

	ChangePersistence.prototype._prepareDirtyChanges = function (aDirtyChanges) {
		var aChanges = [];

		jQuery.each(aDirtyChanges, function (index, oChange) {
			aChanges.push(oChange.getDefinition());
		});

		return aChanges;
	};

	ChangePersistence.prototype.getDirtyChanges = function() {
		return this._aDirtyChanges;
	};

	/**
	 * Prepares a change to be deleted with the next call to
	 * @see {ChangePersistence#saveDirtyChanges};
	 *
	 * If the given change is already in the dirty changes and
	 * has pending action 'NEW' it will be removed, assuming,
	 * it has just been created in the current session;
	 *
	 * Otherwise it will be marked for deletion.
	 *
	 * @param {sap.ui.fl.Change} oChange - the change to be deleted
	 */
	ChangePersistence.prototype.deleteChange = function(oChange) {
		var nIndexInDirtyChanges = this._aDirtyChanges.indexOf(oChange);

		if (nIndexInDirtyChanges > -1) {
			if (oChange.getPendingAction() === "DELETE"){
				return;
			}
			this._aDirtyChanges.splice(nIndexInDirtyChanges, 1);
			this._deleteChangeInMap(oChange);
			return;
		}

		oChange.markForDeletion();
		this._aDirtyChanges.push(oChange);
		this._deleteChangeInMap(oChange);
	};

	/**
	 * Deletes a change object from the internal map.
	 *
	 * @param {sap.ui.fl.Change} oChange which has to be removed from the mapping
	 * @private
	 */
	ChangePersistence.prototype._deleteChangeInMap = function (oChange) {
		var sChangeKey = oChange.getKey();
		var mChanges = this._mChanges.mChanges;
		var mDependencies = this._mChanges.mDependencies;
		var mDependentChangesOnMe = this._mChanges.mDependentChangesOnMe;

		//mChanges
		Object.keys(mChanges).some(function (key) {
			var aChanges = mChanges[key];
			var nIndexInMapElement = aChanges
				.map(function(oExistingChange){
					return oExistingChange.getKey();
				}).indexOf(oChange.getKey());
			if (nIndexInMapElement !== -1) {
				aChanges.splice(nIndexInMapElement, 1);
				return true;
			}
		});

		//mDependencies
		Object.keys(mDependencies).forEach( function(key) {
			if (key === sChangeKey) {
				delete mDependencies[key];
			} else if ( mDependencies[key].dependencies
				&& jQuery.isArray(mDependencies[key].dependencies)
				&& mDependencies[key].dependencies.indexOf(sChangeKey) !== -1 ) {
				mDependencies[key].dependencies.splice(mDependencies[key].dependencies.indexOf(sChangeKey), 1);
				if (mDependencies[key].dependencies.length === 0) {
					delete mDependencies[key];
				}
			}
		});

		//mDependentChangesOnMe
		Object.keys(mDependentChangesOnMe).forEach( function(key) {
			if (key === sChangeKey) {
				delete mDependentChangesOnMe[key];
			} else if ( jQuery.isArray(mDependentChangesOnMe[key])
				&& mDependentChangesOnMe[key].indexOf(sChangeKey) !== -1 ) {
				mDependentChangesOnMe[key].splice(mDependentChangesOnMe[key].indexOf(sChangeKey), 1);
				if (mDependentChangesOnMe[key].length === 0) {
					delete mDependentChangesOnMe[key];
				}
			}
		});
	};

	/**
	 * TODO!!!
	 *
	 * @param {sap.ui.fl.Change} oChange - the change to be deleted
	 */
	ChangePersistence.prototype.loadSwitchChangesMapForComponent = function(sVariantManagementId, sCurrentVariant, sNewVariant) {
		return this._oVariantController.getChangesForVariantSwitch(sVariantManagementId, sCurrentVariant, sNewVariant, this._mChanges.mChanges);
	};

	return ChangePersistence;
}, true);
